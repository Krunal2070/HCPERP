# ══════════════════════════════════════════════════════════════════════════════
# CMS SCRAP VENDOR ADDENDUM  (v2 — with opening balance)
#
# ADD / REPLACE these functions in sampling_portal.py
# Routes are now added directly to app.py — see app.py changes.
# ══════════════════════════════════════════════════════════════════════════════


def cms_init_scrap_vendor_tables():
    """
    Create scrap-vendor tables.
    Called from cms_page() in app.py after cms_init_db().
    Safe to call on every page load — all CREATE statements use IF NOT EXISTS.
    """
    conn = get_db_connection()
    cur  = conn.cursor()

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_scrap_vendors (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            name            VARCHAR(120) NOT NULL,
            contact         VARCHAR(60),
            address         TEXT,
            opening_balance DECIMAL(15,2) NOT NULL DEFAULT 0,
            created_by      VARCHAR(100),
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Add opening_balance column if upgrading from v1 schema
    try:
        cur.execute(
            "ALTER TABLE cms_scrap_vendors ADD COLUMN opening_balance DECIMAL(15,2) NOT NULL DEFAULT 0 AFTER address"
        )
        conn.commit()
    except Exception:
        pass  # column already exists

    cur.execute("""
        CREATE TABLE IF NOT EXISTS cms_scrap_vendor_txn (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            vendor_id   INT NOT NULL,
            txn_type    ENUM('opening','debit','payment') NOT NULL,
            date        DATE NOT NULL,
            amount      DECIMAL(15,2) NOT NULL DEFAULT 0,
            voucher_no  VARCHAR(60),
            description TEXT,
            created_by  VARCHAR(100),
            created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (vendor_id) REFERENCES cms_scrap_vendors(id) ON DELETE CASCADE
        )
    """)

    # Add 'opening' to enum if upgrading from v1
    try:
        cur.execute("""
            ALTER TABLE cms_scrap_vendor_txn
            MODIFY COLUMN txn_type ENUM('opening','debit','payment') NOT NULL
        """)
        conn.commit()
    except Exception:
        pass

    conn.commit()
    conn.close()


# ── helpers ───────────────────────────────────────────────────────────────────

def _sv_today():
    from datetime import date
    return date.today().isoformat()


# ── VENDOR CRUD ───────────────────────────────────────────────────────────────

def cms_get_scrap_vendors():
    """
    Return all scrap vendors with live balance:
        balance = opening_balance + SUM(debit) - SUM(payment)
    Positive = vendor still owes HCP money.
    """
    conn = get_db_connection()
    cur  = conn.cursor()
    cur.execute("""
        SELECT
            v.*,
            COALESCE(v.opening_balance, 0)
          + COALESCE(SUM(CASE WHEN t.txn_type IN ('debit','opening') THEN t.amount ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN t.txn_type = 'payment' THEN t.amount ELSE 0 END), 0)
            AS balance
        FROM cms_scrap_vendors v
        LEFT JOIN cms_scrap_vendor_txn t ON t.vendor_id = v.id
        GROUP BY v.id
        ORDER BY v.name
    """)
    # Subtract opening_balance from sum(opening txns) to avoid double-counting
    # (opening txn stores the ob value; opening_balance col stores same value)
    # Actually: we DO store opening as a txn row, so the vendors.opening_balance
    # column is just for reference / display. The txn row drives the real running balance.
    # So the correct formula is: SUM(debit txns) - SUM(payment txns) + SUM(opening txns)
    # (opening_balance col is NOT added separately — it's already in the txn sum above)
    cur.execute("""
        SELECT
            v.*,
            COALESCE(SUM(CASE WHEN t.txn_type IN ('opening','debit') THEN t.amount ELSE 0 END), 0)
          - COALESCE(SUM(CASE WHEN t.txn_type = 'payment' THEN t.amount ELSE 0 END), 0)
            AS balance
        FROM cms_scrap_vendors v
        LEFT JOIN cms_scrap_vendor_txn t ON t.vendor_id = v.id
        GROUP BY v.id
        ORDER BY v.name
    """)
    vendors = [dict(r) for r in cur.fetchall()]
    conn.close()
    return {'vendors': vendors}


def cms_save_scrap_vendor(payload):
    """
    Create or update a scrap vendor.

    OPENING BALANCE LOGIC
    ─────────────────────
    When creating with opening_balance != 0:
      - Stored in cms_scrap_vendors.opening_balance (for display / reference)
      - Also inserted as txn_type='opening' in cms_scrap_vendor_txn so it
        appears as first row in the ledger (like a B/F entry in accounting)

    When editing:
      - Both the vendor row and the opening txn row are updated in sync.
      - If OB is set to 0, the opening txn row is deleted.
    """
    conn = get_db_connection()
    cur  = conn.cursor()
    try:
        vid     = payload.get('id') or None
        name    = payload['name']
        contact = payload.get('contact', '')
        address = payload.get('address', '')
        ob      = float(payload.get('opening_balance') or 0)
        ob_date = payload.get('ob_date') or _sv_today()
        cby     = payload.get('created_by', '')

        if vid:
            cur.execute("""
                UPDATE cms_scrap_vendors
                SET name=%s, contact=%s, address=%s, opening_balance=%s
                WHERE id=%s
            """, (name, contact, address, ob, vid))

            # Sync the opening txn row
            cur.execute(
                "SELECT id FROM cms_scrap_vendor_txn WHERE vendor_id=%s AND txn_type='opening'",
                (vid,)
            )
            ob_row = cur.fetchone()
            if ob_row:
                if ob != 0:
                    cur.execute(
                        "UPDATE cms_scrap_vendor_txn SET amount=%s, date=%s WHERE id=%s",
                        (abs(ob), ob_date, ob_row['id'])
                    )
                else:
                    cur.execute("DELETE FROM cms_scrap_vendor_txn WHERE id=%s", (ob_row['id'],))
            elif ob != 0:
                cur.execute("""
                    INSERT INTO cms_scrap_vendor_txn
                        (vendor_id, txn_type, date, amount, voucher_no, description, created_by)
                    VALUES (%s,'opening',%s,%s,'OB','Opening Balance',%s)
                """, (vid, ob_date, abs(ob), cby))
        else:
            cur.execute("""
                INSERT INTO cms_scrap_vendors (name, contact, address, opening_balance, created_by)
                VALUES (%s,%s,%s,%s,%s)
            """, (name, contact, address, ob, cby))
            vid = cur.lastrowid

            if ob != 0:
                cur.execute("""
                    INSERT INTO cms_scrap_vendor_txn
                        (vendor_id, txn_type, date, amount, voucher_no, description, created_by)
                    VALUES (%s,'opening',%s,%s,'OB','Opening Balance',%s)
                """, (vid, ob_date, abs(ob), cby))

        conn.commit()
        return {'status': 'ok', 'id': vid}
    except Exception as e:
        conn.rollback()
        return {'status': 'error', 'message': str(e)}
    finally:
        conn.close()


def cms_delete_scrap_vendor(vid):
    """Delete vendor and all transactions (CASCADE)."""
    conn = get_db_connection()
    cur  = conn.cursor()
    try:
        cur.execute("DELETE FROM cms_scrap_vendors WHERE id=%s", (vid,))
        conn.commit()
        return {'status': 'ok'}
    except Exception as e:
        conn.rollback()
        return {'status': 'error', 'message': str(e)}
    finally:
        conn.close()


# ── VENDOR LEDGER ─────────────────────────────────────────────────────────────

def cms_get_scrap_vendor_ledger(vendor_id):
    """
    Full ledger for one vendor, with running balance.

    Row order: opening first, then debit/payment by date asc.
    Display order: reversed (most recent at top) for the table.

    txn_type  | Ledger side
    ----------|------------
    opening   | Debit  (vendor owed us from before)
    debit     | Debit  (scrap sold → vendor owes more)
    payment   | Credit (vendor paid → balance reduces)
    """
    conn = get_db_connection()
    cur  = conn.cursor()

    cur.execute("""
        SELECT * FROM cms_scrap_vendor_txn
        WHERE vendor_id = %s
        ORDER BY
            CASE txn_type WHEN 'opening' THEN 0 ELSE 1 END,
            date ASC, id ASC
    """, (vendor_id,))
    rows = [dict(r) for r in cur.fetchall()]

    total_sold = 0.0
    total_paid = 0.0
    running    = 0.0

    for r in rows:
        amt = float(r['amount'])
        if r['txn_type'] in ('opening', 'debit'):
            running    += amt
            if r['txn_type'] == 'debit':
                total_sold += amt
        else:
            running    -= amt
            total_paid += amt
        r['running_balance'] = round(running, 2)

    ob_amount = next((float(r['amount']) for r in rows if r['txn_type']=='opening'), 0.0)

    rows_desc = list(reversed(rows))
    conn.close()
    return {
        'opening_balance': ob_amount,
        'total_sold':      total_sold,
        'total_paid':      total_paid,
        'balance':         round(running, 2),
        'entries':         rows_desc,
    }


# ── TRANSACTION CRUD ──────────────────────────────────────────────────────────

def cms_save_scrap_vendor_txn(payload):
    """
    Save a debit or payment transaction.
    Auto-generates voucher: DN-YYYYMMDD-NNN / PR-YYYYMMDD-NNN
    """
    conn = get_db_connection()
    cur  = conn.cursor()
    try:
        txn_id    = payload.get('id') or None
        txn_type  = payload['txn_type']
        vendor_id = int(payload['vendor_id'])
        date      = payload['date']
        amount    = float(payload['amount'])
        desc      = payload.get('description', '')
        voucher   = (payload.get('voucher_no') or '').strip()
        cby       = payload.get('created_by', '')

        if not voucher:
            prefix   = 'DN' if txn_type == 'debit' else 'PR'
            date_tag = date.replace('-', '')
            cur.execute(
                "SELECT COUNT(*) AS cnt FROM cms_scrap_vendor_txn WHERE date=%s AND txn_type=%s",
                (date, txn_type)
            )
            seq     = (cur.fetchone()['cnt'] or 0) + 1
            voucher = f"{prefix}-{date_tag}-{seq:03d}"

        if txn_id:
            cur.execute("""
                UPDATE cms_scrap_vendor_txn
                SET vendor_id=%s, txn_type=%s, date=%s, amount=%s,
                    voucher_no=%s, description=%s
                WHERE id=%s
            """, (vendor_id, txn_type, date, amount, voucher, desc, txn_id))
        else:
            cur.execute("""
                INSERT INTO cms_scrap_vendor_txn
                    (vendor_id, txn_type, date, amount, voucher_no, description, created_by)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
            """, (vendor_id, txn_type, date, amount, voucher, desc, cby))
            txn_id = cur.lastrowid

        conn.commit()
        return {'status': 'ok', 'id': txn_id, 'voucher_no': voucher}
    except Exception as e:
        conn.rollback()
        return {'status': 'error', 'message': str(e)}
    finally:
        conn.close()


def cms_get_scrap_vendor_txn(txn_id):
    """Fetch single transaction by ID (for print preview)."""
    conn = get_db_connection()
    cur  = conn.cursor()
    cur.execute("""
        SELECT t.*, v.name AS vendor_name, v.contact AS vendor_contact
        FROM cms_scrap_vendor_txn t
        JOIN cms_scrap_vendors v ON v.id = t.vendor_id
        WHERE t.id = %s
    """, (txn_id,))
    row = cur.fetchone()
    conn.close()
    return dict(row) if row else {}


def cms_delete_scrap_vendor_txn(txn_id):
    """Delete a transaction. Opening balance entries cannot be deleted via UI."""
    conn = get_db_connection()
    cur  = conn.cursor()
    try:
        cur.execute("SELECT txn_type FROM cms_scrap_vendor_txn WHERE id=%s", (txn_id,))
        row = cur.fetchone()
        if row and row['txn_type'] == 'opening':
            return {
                'status':  'error',
                'message': 'Cannot delete opening balance entry. Edit the vendor to change or clear it.'
            }
        cur.execute("DELETE FROM cms_scrap_vendor_txn WHERE id=%s", (txn_id,))
        conn.commit()
        return {'status': 'ok'}
    except Exception as e:
        conn.rollback()
        return {'status': 'error', 'message': str(e)}
    finally:
        conn.close()
