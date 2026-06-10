"""
pm_stock/helpers.py
====================
Pure helper functions and constants for the PM Stock module.
No Flask routes here — only leaf code that routes call into.
"""

from flask import request, session, jsonify, send_file
from functools import wraps
from datetime import datetime, date
import io
import json
import secrets
import sampling_portal   # shared DB helper — provides get_db_connection()


def _login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get('logged_in'):
            return jsonify({'status': 'error', 'message': 'Not logged in'}), 401
        return f(*args, **kwargs)
    return wrapper

def _user():
    return session.get('User_Name') or session.get('UID') or 'Unknown'

# Cache for session-name → canonical-username lookups. The session
# value (`User_Name`) is set by the parent portal at login and on this
# install actually holds the user's full_name (display name), not their
# login username. pm_user_access rows are keyed by the username column
# from User_Tbl (e.g. "testit"), so a direct lookup by session name
# never finds the row.
#
# This cache is process-local and short-lived (cleared on every restart)
# but covers the common case where the same user makes several requests
# in succession.
_USER_NAME_CACHE = {}

def _resolve_canonical_username(name):
    """Given any user identifier from the session (full_name OR username),
    return the canonical login username from User_Tbl. Used for
    pm_user_access lookups so admin-saved rows resolve correctly even
    when the session stores the display name.

    Falls back to the input string verbatim if the lookup fails or no
    match is found — so existing behavior (lookup by whatever the
    session holds) is preserved as the last-resort path.
    """
    if not name or name == 'Unknown':
        return name
    cached = _USER_NAME_CACHE.get(name)
    if cached is not None:
        return cached
    try:
        conn = sampling_portal.get_db_connection()
        try:
            # Try mixed-case "User_Tbl" first, then lowercase as fallback —
            # matches the case-sensitivity work done in the users-list
            # endpoint. Look up by EITHER username OR full_name.
            row = None
            for table_name in ('User_Tbl', 'user_tbl'):
                try:
                    row = conn.execute(f"""
                        SELECT username FROM {table_name}
                        WHERE username = %s OR full_name = %s
                        LIMIT 1
                    """, (name, name)).fetchone()
                    if row:
                        break
                except Exception:
                    continue
            if row:
                resolved = (row.get('username') if hasattr(row, 'get') else row[0]) or name
                _USER_NAME_CACHE[name] = resolved
                return resolved
        finally:
            try: conn.close()
            except Exception: pass
    except Exception:
        pass
    # No match — cache the input so we don't keep hitting the DB.
    _USER_NAME_CACHE[name] = name
    return name

def ensure_pm_tables():
    """Create / migrate PM stock tables."""
    conn = sampling_portal.get_db_connection()
    if not conn:
        return

    # ── Products ─────────────────────────────────────────────────────────────
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_products (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            product_name VARCHAR(500) NOT NULL,
            pm_type      VARCHAR(100) NOT NULL,
            brand_id     INT          DEFAULT NULL,
            is_active    TINYINT(1)   DEFAULT 1,
            created_at   DATETIME     DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_pm_product (product_name(300), pm_type(80))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    for col, ddl in [
        ('brand_id',     "ALTER TABLE pm_products ADD COLUMN brand_id INT DEFAULT NULL AFTER pm_type"),
        ('min_stock',    "ALTER TABLE pm_products ADD COLUMN min_stock INT DEFAULT 0 AFTER brand_id"),
        ('product_code', "ALTER TABLE pm_products ADD COLUMN product_code VARCHAR(10) DEFAULT NULL AFTER product_name"),
        # UOM (Tally-style): every product has a primary UOM (default 'Nos').
        # An optional alternate UOM with a conversion ratio expressed as
        # 1 primary = alt_to_primary_ratio × alternate (Tally style).
        # Example: Kg as primary, Nos as alternate, ratio=15000 means
        #   "1 Kg = 15,000 Nos". All stock numbers in the DB are in primary;
        # the alternate is only an input convenience for voucher entry.
        ('primary_uom',          "ALTER TABLE pm_products ADD COLUMN primary_uom VARCHAR(20) NOT NULL DEFAULT 'Nos'"),
        ('alt_uom',              "ALTER TABLE pm_products ADD COLUMN alt_uom VARCHAR(20) DEFAULT NULL"),
        ('alt_to_primary_ratio', "ALTER TABLE pm_products ADD COLUMN alt_to_primary_ratio DECIMAL(14,4) DEFAULT NULL"),
    ]:
        try:
            conn.execute(ddl); conn.commit()
        except Exception:
            pass

    # Unique index on product_code (only when populated; allows multiple NULLs)
    try:
        conn.execute("ALTER TABLE pm_products ADD UNIQUE INDEX uq_pm_product_code (product_code)")
        conn.commit()
    except Exception:
        pass

    # ── Godown transactions ───────────────────────────────────────────────────
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_godown_txn (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            product_id   INT          NOT NULL,
            txn_date     DATE         NOT NULL,
            txn_type     ENUM('opening','inward','outward') NOT NULL,
            qty          DECIMAL(12,2) NOT NULL DEFAULT 0,
            remarks      VARCHAR(500)  DEFAULT '',
            created_by   VARCHAR(100)  DEFAULT '',
            created_at   DATETIME      DEFAULT CURRENT_TIMESTAMP,
            voucher_no   VARCHAR(50)   DEFAULT NULL,
            godown_id    INT           DEFAULT NULL,
            FOREIGN KEY (product_id) REFERENCES pm_products(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    for col, ddl in [
        ('voucher_no', "ALTER TABLE pm_godown_txn ADD COLUMN voucher_no VARCHAR(50) DEFAULT NULL"),
        ('godown_id',  "ALTER TABLE pm_godown_txn ADD COLUMN godown_id INT DEFAULT NULL"),
    ]:
        try:
            conn.execute(ddl); conn.commit()
        except Exception:
            pass

    # ── Floor transactions ────────────────────────────────────────────────────
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_floor_txn (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            product_id   INT          NOT NULL,
            txn_date     DATE         NOT NULL,
            txn_type     ENUM('floor_opening','issue','dispatch','rejection','pm_return') NOT NULL,
            qty          DECIMAL(12,2) NOT NULL DEFAULT 0,
            remarks      VARCHAR(500)  DEFAULT '',
            created_by   VARCHAR(100)  DEFAULT '',
            created_at   DATETIME      DEFAULT CURRENT_TIMESTAMP,
            voucher_no   VARCHAR(50)   DEFAULT NULL,
            godown_id    INT           DEFAULT NULL,
            FOREIGN KEY (product_id) REFERENCES pm_products(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    for col, ddl in [
        ('voucher_no', "ALTER TABLE pm_floor_txn ADD COLUMN voucher_no VARCHAR(50) DEFAULT NULL"),
        ('godown_id',  "ALTER TABLE pm_floor_txn ADD COLUMN godown_id INT DEFAULT NULL"),
    ]:
        try:
            conn.execute(ddl); conn.commit()
        except Exception:
            pass

    # ── PM GRN ────────────────────────────────────────────────────────────────
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_grn (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            grn_no       VARCHAR(50)  NOT NULL UNIQUE,
            grn_date     DATE         NOT NULL,
            po_number    VARCHAR(100) DEFAULT NULL,
            po_date      DATE         DEFAULT NULL,
            supplier     VARCHAR(300) DEFAULT '',
            godown_id    INT          DEFAULT NULL,
            remarks      VARCHAR(500) DEFAULT '',
            created_by   VARCHAR(100) DEFAULT '',
            created_at   DATETIME     DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # Migrate pm_grn: add party invoice + supervisor + verification fields if missing
    for col, ddl in [
        ('party_invoice_no',   "ALTER TABLE pm_grn ADD COLUMN party_invoice_no VARCHAR(100) DEFAULT NULL"),
        ('party_invoice_date', "ALTER TABLE pm_grn ADD COLUMN party_invoice_date DATE DEFAULT NULL"),
        ('supervisor_name',    "ALTER TABLE pm_grn ADD COLUMN supervisor_name VARCHAR(200) DEFAULT NULL"),
        # ── GRN verification (box-scan post-save flow) ──
        # When the admin toggle `grn_verify_required` is ON, GRN saves are
        # parked in 'pending' status — no inward stock posted — and the
        # operator must scan every box on the GRN to flip status to
        # 'verified' (at which point stock posts). Default 'verified'
        # makes legacy / toggle-off saves backward compatible.
        ('verification_status', "ALTER TABLE pm_grn ADD COLUMN verification_status VARCHAR(20) NOT NULL DEFAULT 'verified'"),
        ('verified_at',         "ALTER TABLE pm_grn ADD COLUMN verified_at DATETIME DEFAULT NULL"),
        ('verified_by',         "ALTER TABLE pm_grn ADD COLUMN verified_by VARCHAR(80) DEFAULT NULL"),
    ]:
        try:
            conn.execute(ddl); conn.commit()
        except Exception:
            pass

    # ── Discrepancy reports for failed GRN verifications ──
    # Every verify attempt that fails (missing boxes, unknown codes,
    # duplicate scans, qty drift) writes one row here with a JSON payload
    # of what went wrong. The PDF (if reportlab is available) is rendered
    # on disk; we track the path so re-downloads don't have to regenerate.
    # Frontend reads report_id from the verify endpoint's response and
    # uses it for download / share buttons.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_grn_discrepancy_reports (
            report_id        INT AUTO_INCREMENT PRIMARY KEY,
            grn_id           INT NOT NULL,
            grn_no           VARCHAR(40) NOT NULL,
            report_no        VARCHAR(40) NOT NULL UNIQUE,
            mismatch_kind    VARCHAR(40) NOT NULL,
            scanned_count    INT DEFAULT 0,
            expected_count   INT DEFAULT 0,
            box_total        DECIMAL(14,3) DEFAULT 0,
            item_total       DECIMAL(14,3) DEFAULT 0,
            payload_json     LONGTEXT,
            note             VARCHAR(1000) DEFAULT NULL,
            pdf_path         VARCHAR(500) DEFAULT NULL,
            created_by       VARCHAR(80) NOT NULL,
            created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            INDEX ix_pm_grn_disc_grn  (grn_id),
            INDEX ix_pm_grn_disc_kind (mismatch_kind)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_grn_items (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            grn_id       INT          NOT NULL,
            product_id   INT          NOT NULL,
            qty_received DECIMAL(12,2) NOT NULL DEFAULT 0,
            no_of_box    INT          DEFAULT 0,
            box_count    INT          DEFAULT 0,
            remarks      VARCHAR(300) DEFAULT '',
            FOREIGN KEY (grn_id)     REFERENCES pm_grn(id)     ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES pm_products(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # Migrate pm_grn_items: add no_of_box + box_count for existing installations
    for col, ddl in [
        ('no_of_box',   "ALTER TABLE pm_grn_items ADD COLUMN no_of_box INT DEFAULT 0"),
        ('box_count',   "ALTER TABLE pm_grn_items ADD COLUMN box_count INT DEFAULT 0"),
        # Phase 2: per-line UOM label. NULL = "use the product's primary UOM
        # at display time". No conversion math at this stage — the qty values
        # mean exactly what they did before; this column just records which
        # UOM label the user picked. Existing rows stay NULL and read as
        # primary UOM, so historical data is untouched.
        ('entered_uom', "ALTER TABLE pm_grn_items ADD COLUMN entered_uom VARCHAR(20) DEFAULT NULL"),
        # ABC Analysis prerequisite: unit rate at receipt time. Used by the
        # ABC report to compute material value (= Σ qty × rate). Optional —
        # legacy lines stay 0 and simply contribute 0 to the value pool. The
        # GRN modal exposes this as an optional "Rate (₹)" input per line.
        ('rate',        "ALTER TABLE pm_grn_items ADD COLUMN rate DECIMAL(15,4) NOT NULL DEFAULT 0"),
    ]:
        try:
            conn.execute(ddl); conn.commit()
        except Exception:
            pass

    # ── Material Transfer Vouchers (legacy MTV — coexists with new pm_transfers) ─
    # MTV vouchers are still used alongside the newer voucher-based Material
    # Transfer system (pm_transfers). Both coexist and both feed the combined
    # Voucher Log.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_mtv (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            mtv_no       VARCHAR(50)  NOT NULL UNIQUE,
            mtv_date     DATE         NOT NULL,
            from_godown  INT          NOT NULL,
            to_godown    INT          NOT NULL,
            from_type    ENUM('godown','floor') DEFAULT 'godown',
            to_type      ENUM('godown','floor') DEFAULT 'godown',
            remarks      VARCHAR(500) DEFAULT '',
            created_by   VARCHAR(100) DEFAULT '',
            created_at   DATETIME     DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_mtv_items (
            id           INT AUTO_INCREMENT PRIMARY KEY,
            mtv_id       INT          NOT NULL,
            product_id   INT          NOT NULL,
            qty          DECIMAL(12,2) NOT NULL DEFAULT 0,
            remarks      VARCHAR(300) DEFAULT '',
            FOREIGN KEY (mtv_id)     REFERENCES pm_mtv(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES pm_products(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # ── Delivery Notes (HCP → Supplier, outbound) ─────────────────────────────
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_dn (
            id                INT AUTO_INCREMENT PRIMARY KEY,
            dn_no             VARCHAR(50)  NOT NULL UNIQUE,
            dn_date           DATE         NOT NULL,
            supplier          VARCHAR(200) DEFAULT '',
            from_godown       INT          DEFAULT NULL,
            reason            VARCHAR(200) DEFAULT '',
            remarks           VARCHAR(500) DEFAULT '',
            supervisor_name   VARCHAR(200) DEFAULT NULL,
            reference_no      VARCHAR(100) DEFAULT NULL,
            reference_date    DATE         DEFAULT NULL,
            created_by        VARCHAR(100) DEFAULT '',
            created_at        DATETIME     DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_dn_items (
            id             INT AUTO_INCREMENT PRIMARY KEY,
            dn_id          INT          NOT NULL,
            product_id     INT          NOT NULL,
            qty_delivered  DECIMAL(12,2) NOT NULL DEFAULT 0,
            no_of_box      INT          DEFAULT 0,
            box_count      INT          DEFAULT 0,
            remarks        VARCHAR(300) DEFAULT '',
            FOREIGN KEY (dn_id)      REFERENCES pm_dn(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES pm_products(id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # ── pm_dn_box_scans ───────────────────────────────────────────────────────
    # Junction table: which physical boxes are attached to which DN line.
    # When boxes are present on a DN line, the box's current_status becomes
    # 'consumed' (it left inventory on this DN) and prior_godown_id snapshots
    # where the box was sitting before — so DN edits or deletes can restore
    # the box back to 'in_stock' at its original location if the operator
    # removes it from the DN list.
    #
    # dn_item_id is nullable so the row survives DN edits (which currently
    # do DELETE/INSERT on pm_dn_items); the box stays linked to the dn_id
    # and we relink to a (possibly new) item_id on each save.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_dn_box_scans (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            dn_id           INT          NOT NULL,
            dn_item_id      INT          DEFAULT NULL,
            box_id          INT          NOT NULL,
            box_code        VARCHAR(40)  NOT NULL,
            product_id      INT          NOT NULL,
            per_box_qty     DECIMAL(12,3) NOT NULL DEFAULT 0,
            prior_godown_id INT          DEFAULT NULL,
            created_at      DATETIME     DEFAULT CURRENT_TIMESTAMP,
            created_by      VARCHAR(50)  DEFAULT NULL,
            UNIQUE KEY uq_dn_box (dn_id, box_id),
            INDEX ix_dn_box_scans_dn   (dn_id),
            INDEX ix_dn_box_scans_box  (box_id),
            FOREIGN KEY (dn_id) REFERENCES pm_dn(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # ── Material Request tables ───────────────────────────────────────────────
    # A Material Request is a non-stock-affecting pre-order: a user at the
    # destination location declares "I need X qty of product Y here". A
    # fulfiller (anyone with Material OUT permission) then creates one or
    # more Material OUT vouchers against the request — each OUT links its
    # line items back to the request lines via pm_material_request_links.
    # Status auto-progresses by comparing SUM(links.qty_fulfilled) per
    # request item against item.qty_requested:
    #   - 0 fulfilled total       → 'pending'
    #   - some, not all complete  → 'in_progress'
    #   - every line fully covered → 'fulfilled'
    #   - manual cancel           → 'cancelled' (only allowed when nothing fulfilled)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_material_requests (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            request_no      VARCHAR(40)  NOT NULL UNIQUE,
            request_date    DATE         NOT NULL,
            dest_godown_id  INT          NOT NULL,
            requested_by    VARCHAR(80)  NOT NULL,
            status          ENUM('pending','in_progress','fulfilled','cancelled')
                            NOT NULL DEFAULT 'pending',
            remarks         VARCHAR(500) DEFAULT NULL,
            cancelled_by    VARCHAR(80)  DEFAULT NULL,
            cancelled_at    DATETIME     DEFAULT NULL,
            cancel_reason   VARCHAR(500) DEFAULT NULL,
            created_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
            INDEX ix_pm_mr_status (status),
            INDEX ix_pm_mr_date   (request_date),
            INDEX ix_pm_mr_by     (requested_by)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    # Migrate: optional source_godown_id (which godown the requester
    # suggests material be pulled from). NULL = fulfiller's choice at
    # OUT-creation time.
    #
    # Also: BOM source-tracking columns. When an MR is auto-built from
    # a BOM via the "From BOM" shortcut, these stamps let us answer
    # later "what BOM and version was this MR built from? Were the
    # quantities correct for that version's recipe?" without snapshotting
    # the whole recipe into the MR (the line items themselves are the
    # snapshot — these are just the trail).
    for col, ddl in [
        ('source_godown_id',  "ALTER TABLE pm_material_requests ADD COLUMN source_godown_id INT DEFAULT NULL"),
        ('source_bom_id',     "ALTER TABLE pm_material_requests ADD COLUMN source_bom_id INT DEFAULT NULL"),
        ('source_bom_version',"ALTER TABLE pm_material_requests ADD COLUMN source_bom_version INT DEFAULT NULL"),
        ('source_bom_qty',    "ALTER TABLE pm_material_requests ADD COLUMN source_bom_qty DECIMAL(14,3) DEFAULT NULL"),
    ]:
        try:
            conn.execute(ddl); conn.commit()
        except Exception:
            pass
    # Migrate: add 'closed' to the status ENUM. 'closed' = requester (or admin)
    # pre-closed the request early with a reason — whatever was already
    # fulfilled stays; the unfulfilled remainder is no longer needed. Distinct
    # from 'cancelled' (abandoned at 0 fulfilment). Idempotent.
    try:
        conn.execute(
            "ALTER TABLE pm_material_requests MODIFY COLUMN status "
            "ENUM('pending','in_progress','fulfilled','cancelled','closed') "
            "NOT NULL DEFAULT 'pending'"
        )
        conn.commit()
    except Exception:
        pass
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_material_request_items (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            request_id      INT          NOT NULL,
            product_id      INT          NOT NULL,
            qty_requested   DECIMAL(14,3) NOT NULL,
            qty_fulfilled   DECIMAL(14,3) NOT NULL DEFAULT 0,
            remarks         VARCHAR(300) DEFAULT NULL,
            INDEX ix_pm_mri_request (request_id),
            INDEX ix_pm_mri_product (product_id),
            FOREIGN KEY (request_id) REFERENCES pm_material_requests(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    # Migrate: optional product_version the requester selects from the
    # versions currently in stock (e.g. "OLD DESIGN" / "NEW DESIGN"), so the
    # fulfiller ships the right variant. NULL/'' = any version. Idempotent.
    try:
        conn.execute("ALTER TABLE pm_material_request_items ADD COLUMN product_version VARCHAR(60) DEFAULT NULL")
        conn.commit()
    except Exception:
        pass
    # UOM (Phase 3) — what the requester actually typed in.
    # entered_uom: the UOM the requester selected when entering this line
    #   (typically the product's alt_uom when configured). NULL = no alt was
    #   used; qty_requested IS the user-facing number.
    # entered_qty: the original number the user typed (in entered_uom). When
    #   entered_uom is set, qty_requested holds the converted-to-primary
    #   value used for fulfillment math; entered_qty preserves user intent
    #   for the printed voucher's conversion matrix.
    for _ddl in (
        "ALTER TABLE pm_material_request_items ADD COLUMN entered_uom VARCHAR(20) DEFAULT NULL",
        "ALTER TABLE pm_material_request_items ADD COLUMN entered_qty DECIMAL(14,3) DEFAULT NULL",
    ):
        try:
            conn.execute(_ddl); conn.commit()
        except Exception:
            pass
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_material_request_links (
            id                INT AUTO_INCREMENT PRIMARY KEY,
            request_item_id   INT          NOT NULL,
            transfer_id       INT          NOT NULL,
            transfer_item_id  INT          DEFAULT NULL,
            qty_fulfilled     DECIMAL(14,3) NOT NULL,
            fulfilled_by      VARCHAR(80)  NOT NULL,
            fulfilled_at      TIMESTAMP    DEFAULT CURRENT_TIMESTAMP,
            INDEX ix_pm_mrl_ri (request_item_id),
            INDEX ix_pm_mrl_tx (transfer_id),
            FOREIGN KEY (request_item_id) REFERENCES pm_material_request_items(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # ── Purchase Orders ──────────────────────────────────────────────────────
    # PM POs are a planning + control layer on top of GRN. The lifecycle and
    # approval are tracked on two independent axes:
    #   status          — draft / open / partial / closed / cancelled
    #   approval_status — pending / approved / rejected
    # A PO can only be received-against when (approval_status='approved' AND
    # status IN ('open','partial')). The PO is optional — direct GRNs still
    # work (pm_grn.po_id stays NULL for those).
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_purchase_orders (
            id                  INT AUTO_INCREMENT PRIMARY KEY,
            po_num              VARCHAR(50)  NOT NULL,
            po_date             DATE         DEFAULT NULL,
            supplier_id         INT          DEFAULT NULL,
            supplier_name       VARCHAR(500) DEFAULT NULL,
            godown_id           INT          DEFAULT NULL,
            delivery_date       DATE         DEFAULT NULL,
            delivery_days       INT          DEFAULT NULL,
            status              ENUM('draft','open','partial','closed','cancelled')
                                NOT NULL DEFAULT 'draft',
            approval_status     ENUM('pending','approved','rejected')
                                NOT NULL DEFAULT 'pending',
            approved_by         VARCHAR(200) DEFAULT NULL,
            approved_at         DATETIME     DEFAULT NULL,
            rejection_reason    TEXT         DEFAULT NULL,
            grand_total         DECIMAL(18,4) DEFAULT NULL,
            freight_charge      DECIMAL(15,4) DEFAULT NULL,
            packing_charge      DECIMAL(15,4) DEFAULT NULL,
            tc_list_id          INT          DEFAULT NULL,
            declaration_id      INT          DEFAULT NULL,
            remarks             TEXT         DEFAULT NULL,
            created_by          VARCHAR(200) DEFAULT NULL,
            updated_by          VARCHAR(200) DEFAULT NULL,
            created_at          DATETIME     DEFAULT CURRENT_TIMESTAMP,
            updated_at          DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_pm_po_num (po_num),
            INDEX ix_pm_po_status (status),
            INDEX ix_pm_po_appr   (approval_status),
            INDEX ix_pm_po_date   (po_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_po_items (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            po_id           INT           NOT NULL,
            product_id      INT           NOT NULL,
            qty             DECIMAL(15,3) DEFAULT NULL,
            entered_uom     VARCHAR(20)   DEFAULT NULL,
            entered_qty     DECIMAL(15,3) DEFAULT NULL,
            qty_primary     DECIMAL(15,3) DEFAULT NULL,
            rate            DECIMAL(15,4) DEFAULT NULL,
            amount          DECIMAL(18,4) DEFAULT NULL,
            gst_rate        DECIMAL(5,2)  DEFAULT NULL,
            cgst_amount     DECIMAL(18,4) DEFAULT NULL,
            sgst_amount     DECIMAL(18,4) DEFAULT NULL,
            product_version VARCHAR(60)   DEFAULT NULL,
            remarks         TEXT          DEFAULT NULL,
            INDEX ix_pm_po_items_po (po_id),
            INDEX ix_pm_po_items_pr (product_id),
            FOREIGN KEY (po_id) REFERENCES pm_purchase_orders(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    # Additive: pm_grn links to a PO when one was raised. Nullable; existing
    # direct GRNs keep po_id = NULL. Auto-migration is idempotent.
    for _ddl in (
        "ALTER TABLE pm_grn ADD COLUMN po_id  INT          DEFAULT NULL",
        "ALTER TABLE pm_grn ADD COLUMN po_num VARCHAR(50)  DEFAULT NULL",
        "ALTER TABLE pm_grn ADD INDEX ix_pm_grn_po (po_id)",
    ):
        try:
            conn.execute(_ddl); conn.commit()
        except Exception:
            pass

    # ── Voucher Sequences ─────────────────────────────────────────────────────
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_voucher_sequences (
            voucher_type VARCHAR(50) PRIMARY KEY,
            prefix       VARCHAR(20)  DEFAULT '',
            last_num     INT          DEFAULT 0,
            pad_digits   INT          DEFAULT 4,
            reset_yearly TINYINT(1)   DEFAULT 1,
            last_year    INT          DEFAULT 0
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # Seed default sequences if missing
    defaults = [
        ('PM-GRN',  'PMG',  0, 4, 1),
        ('PM-MT',   'PMT',  0, 4, 1),    # Material Transfer (new voucher-based system)
        ('PM-DN',   'PMD',  0, 4, 1),
        ('PM-MR',   'PMR',  0, 4, 1),    # Material Request (non-stock pre-order)
        ('PM-GTXN', 'PG',   0, 5, 0),
        ('PM-FTXN', 'PF',   0, 5, 0),
    ]
    for vtype, prefix, last, pad, ry in defaults:
        try:
            conn.execute(
                "INSERT IGNORE INTO pm_voucher_sequences (voucher_type, prefix, last_num, pad_digits, reset_yearly) VALUES (%s,%s,%s,%s,%s)",
                (vtype, prefix, last, pad, ry)
            )
        except Exception:
            pass

    conn.commit()

    # ── Supplier type association for PM Stock page ──────────────────────────
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_supplier_type_assoc (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            supplier_type_id INT NOT NULL,
            page            VARCHAR(50) NOT NULL DEFAULT 'pm_stock',
            UNIQUE KEY uq_pm_sup_type (supplier_type_id, page)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # ── Box tracking tables (Phase 1: foundations) ─────────────────────────
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_boxes (
            box_id              INT AUTO_INCREMENT PRIMARY KEY,
            box_code            VARCHAR(40) NOT NULL UNIQUE,
            grn_id              INT NOT NULL,
            grn_no              VARCHAR(50) NOT NULL,
            grn_item_id         INT NOT NULL,
            product_id          INT NOT NULL,
            product_code        VARCHAR(10) DEFAULT NULL,
            box_seq             INT NOT NULL,
            total_boxes         INT NOT NULL,
            per_box_qty         DECIMAL(12,3) NOT NULL DEFAULT 0,
            current_godown_id   INT DEFAULT NULL,
            current_status      ENUM('in_stock','in_transit','consumed','damaged','lost') NOT NULL DEFAULT 'in_stock',
            created_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at          DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            created_by          VARCHAR(50) DEFAULT NULL,
            INDEX ix_pm_boxes_grn (grn_id),
            INDEX ix_pm_boxes_product (product_id),
            INDEX ix_pm_boxes_godown (current_godown_id, current_status),
            INDEX ix_pm_boxes_status (current_status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_box_movements (
            movement_id     INT AUTO_INCREMENT PRIMARY KEY,
            box_id          INT NOT NULL,
            transfer_id     INT DEFAULT NULL,
            movement_type   ENUM('grn_create','out','in','consume','adjust','cancel') NOT NULL,
            from_godown_id  INT DEFAULT NULL,
            to_godown_id    INT DEFAULT NULL,
            qty             DECIMAL(12,3) NOT NULL DEFAULT 0,
            movement_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
            moved_by        VARCHAR(50) DEFAULT NULL,
            remarks         VARCHAR(255) DEFAULT NULL,
            INDEX ix_pm_boxmv_box (box_id),
            INDEX ix_pm_boxmv_transfer (transfer_id),
            INDEX ix_pm_boxmv_at (movement_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # ── Box-split feature migrations (additive, idempotent) ───────────────
    # Add the columns + extend the enums in-place so existing DBs catch up.
    # Each ALTER is wrapped in its own try/except — a column that already
    # exists raises a duplicate-column error which we ignore.
    for ddl in [
        # parent_box_id + split_at on pm_boxes — track split lineage.
        "ALTER TABLE pm_boxes ADD COLUMN parent_box_id INT NULL DEFAULT NULL AFTER box_id",
        "ALTER TABLE pm_boxes ADD COLUMN split_at DATETIME NULL DEFAULT NULL",
        # Index for lookups: "what children did box X spawn?"
        "ALTER TABLE pm_boxes ADD INDEX ix_pm_boxes_parent (parent_box_id)",
        # Extend status enum with 'superseded' — set on a parent box once it
        # has been split. Scans against a superseded box should be rejected.
        ("ALTER TABLE pm_boxes MODIFY COLUMN current_status "
         "ENUM('in_stock','in_transit','consumed','damaged','lost','superseded') "
         "NOT NULL DEFAULT 'in_stock'"),
        # Extend movement_type enum with 'split' — audit row written when
        # a parent is split into children.
        ("ALTER TABLE pm_box_movements MODIFY COLUMN movement_type "
         "ENUM('grn_create','out','in','consume','adjust','cancel','split') NOT NULL"),
        # ── Box-group (lot/bag) feature ──
        # group_id on pm_boxes points at the bag this box belongs to (if any).
        # NULL = box is loose / not bagged. Indexed for fast "boxes in group X"
        # lookups even though we maintain a denormalized member table too.
        "ALTER TABLE pm_boxes ADD COLUMN group_id INT NULL DEFAULT NULL AFTER parent_box_id",
        "ALTER TABLE pm_boxes ADD INDEX ix_pm_boxes_group (group_id)",
        # ── Short-code feature (8-char sequential QR payload) ──
        # An 8-character compact alphanumeric ID stored alongside the legacy
        # box_code. Format: 1 letter + 7 digits (A0000001 .. A9999999), then
        # B0000001 etc. through Z9999999, then AA0000001 etc. The QR on
        # newly-printed labels encodes this short_code (~8 chars) instead of
        # the long box_code (~22 chars), so codes are easier to type by hand
        # if the QR is damaged and the operator has to enter the code in
        # the scan box manually.
        #
        # VARCHAR(12) gives headroom for AAA0000001-style codes (~175B
        # codes) without a future migration. NULL on legacy rows is fine —
        # scan lookup OR-clauses fall back to box_code for those.
        "ALTER TABLE pm_boxes ADD COLUMN short_code VARCHAR(12) NULL DEFAULT NULL",
        "ALTER TABLE pm_boxes ADD UNIQUE INDEX uq_pm_boxes_short_code (short_code)",
        # ── Product version (per-line free-text label) ──
        # GRN operators sometimes receive boxes that need a free-text marker
        # alongside the product name — e.g. "OLD DESIGN", "NEW CAP", "v2",
        # "PG→Glass". The version is per-GRN-line and copied onto each
        # physical box so it travels with the box through MTV/DN/audit.
        # The label printer appends "[VERSION]" to the product name; the
        # GRN's printed voucher does the same. NULL means "no version".
        "ALTER TABLE pm_grn_items ADD COLUMN product_version VARCHAR(60) NULL DEFAULT NULL",
        "ALTER TABLE pm_boxes      ADD COLUMN product_version VARCHAR(60) NULL DEFAULT NULL",
        # ── Material Request linkage on transfers ──
        # When a Material OUT is created to fulfill a Material Request,
        # the request_id is stamped on pm_transfers so the save_out flow
        # can call _link_transfer_to_request() to update the request's
        # fulfillment status. NULL = transfer wasn't created from a
        # request (the normal case).
        "ALTER TABLE pm_transfers ADD COLUMN request_id INT NULL DEFAULT NULL",
        "ALTER TABLE pm_transfers ADD INDEX ix_pm_transfers_request (request_id)",
    ]:
        try:
            conn.execute(ddl); conn.commit()
        except Exception:
            pass

    # ── Short-code uniqueness self-check + empty-string normalisation ─────
    # Runs idempotently on every startup. Empty strings in short_code don't
    # benefit from the unique index (MySQL treats '' as a real distinct
    # value), so normalise to NULL. Skip the heavier backfill loop here —
    # callers assign codes on box creation, and the sequential generator
    # finds MAX+1 from existing rows so any NULL ones just stay NULL until
    # explicitly assigned (which protects against startup-time pinning on
    # large installs).
    try:
        idx_check = conn.execute(
            """SELECT COUNT(*) AS n
               FROM information_schema.statistics
               WHERE table_schema = DATABASE()
                 AND table_name   = 'pm_boxes'
                 AND index_name   = 'uq_pm_boxes_short_code'"""
        ).fetchone()
        if not idx_check or int(idx_check.get('n') or 0) == 0:
            import sys as _sys
            print(
                "[pm_stock] WARNING: pm_boxes.uq_pm_boxes_short_code unique "
                "index is MISSING. Short-code uniqueness is not enforced at "
                "the DB level. Investigate duplicates blocking ADD UNIQUE INDEX.",
                file=_sys.stderr
            )
        # Normalise any '' to NULL so the unique index applies properly.
        conn.execute("UPDATE pm_boxes SET short_code=NULL WHERE short_code=''")
        conn.commit()
    except Exception as _e:
        import sys as _sys
        print(f"[pm_stock] short_code self-check skipped: {_e}", file=_sys.stderr)

    # ── Box-group tables ──────────────────────────────────────────────────
    # A "group" or "bag" is a physical bundle of boxes shipped together.
    # Operator scans the group sticker → all member boxes are processed in
    # one pass. Keeping this in its own pair of tables (rather than another
    # column on pm_boxes) gives us status/location tracking at the group
    # level cleanly, without polluting the box record with derived state.
    #
    # Constraints:
    #   • All members of a group share the same product_id (Phase 1 lock-in).
    #   • A box can belong to at most ONE group at a time. Enforced by the
    #     UNIQUE KEY on pm_box_group_members.box_id below — attempting to
    #     add a box to a second group raises a duplicate-key error.
    #   • current_status mirrors the most-restricted member status:
    #       all in_stock at same godown   → 'in_stock'
    #       any in_transit                → 'in_transit'
    #       members at different godowns  → 'partial'
    #       all members consumed/lost     → 'consumed'
    #       group broken / merged elsewhere → 'superseded'
    #     Computed by _refresh_group_status() after every group operation.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_box_groups (
            group_id          INT AUTO_INCREMENT PRIMARY KEY,
            group_code        VARCHAR(40) NOT NULL UNIQUE,
            group_label       VARCHAR(120) DEFAULT NULL,
            product_id        INT NOT NULL,
            grn_id            INT DEFAULT NULL,
            grn_no            VARCHAR(40) DEFAULT NULL,
            current_godown_id INT NOT NULL,
            current_status    ENUM('in_stock','in_transit','partial','superseded','consumed')
                              NOT NULL DEFAULT 'in_stock',
            member_count      INT NOT NULL DEFAULT 0,
            total_qty         DECIMAL(14,3) NOT NULL DEFAULT 0,
            created_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_by        VARCHAR(64) DEFAULT NULL,
            remarks           VARCHAR(255) DEFAULT NULL,
            INDEX ix_pmg_product (product_id),
            INDEX ix_pmg_grn (grn_id),
            INDEX ix_pmg_godown_status (current_godown_id, current_status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_box_group_members (
            group_id  INT NOT NULL,
            box_id    INT NOT NULL,
            added_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (group_id, box_id),
            UNIQUE KEY uq_pmgm_box (box_id),
            INDEX ix_pmgm_group (group_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_transfers (
            transfer_id     INT AUTO_INCREMENT PRIMARY KEY,
            transfer_no     VARCHAR(30) NOT NULL UNIQUE,
            from_godown_id  INT NOT NULL,
            to_godown_id    INT NOT NULL,
            status          ENUM('out_started','in_pending','received','cancelled') NOT NULL DEFAULT 'out_started',
            out_at          DATETIME DEFAULT CURRENT_TIMESTAMP,
            out_by          VARCHAR(50) DEFAULT NULL,
            in_at           DATETIME DEFAULT NULL,
            in_by           VARCHAR(50) DEFAULT NULL,
            total_boxes     INT NOT NULL DEFAULT 0,
            total_qty       DECIMAL(14,3) NOT NULL DEFAULT 0,
            remarks         TEXT,
            INDEX ix_pm_xfer_status (status),
            INDEX ix_pm_xfer_dest (to_godown_id, status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # Edit audit log for transfers — every state-changing action gets logged here.
    # Used in voucher prints to show "Created by X · Last edited by Y" when the
    # latest editor differs from the original creator.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_transfer_edits (
            edit_id         INT AUTO_INCREMENT PRIMARY KEY,
            transfer_id     INT NOT NULL,
            action          VARCHAR(40) NOT NULL,
            edited_by       VARCHAR(50) NOT NULL,
            edited_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
            details         VARCHAR(500) DEFAULT NULL,
            INDEX ix_pm_xfer_edit (transfer_id, edited_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # Voucher line items — explicit rows for the voucher-based transfer flow.
    # One row per (transfer, side, product), where side='out' (source-side what
    # was packed) or 'in' (destination-side what arrived). On save, OUT lines
    # decrement source stock and IN lines increment destination stock. The
    # transfer is "complete" only when OUT and IN line totals match per product.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_transfer_items (
            item_id         INT AUTO_INCREMENT PRIMARY KEY,
            transfer_id     INT NOT NULL,
            side            ENUM('out','in') NOT NULL DEFAULT 'out',
            product_id      INT NOT NULL,
            no_of_box       INT NOT NULL DEFAULT 0,
            per_box_qty     DECIMAL(14,3) NOT NULL DEFAULT 0,
            total_qty       DECIMAL(14,3) NOT NULL DEFAULT 0,
            created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
            -- per_box_qty MUST be part of the uniqueness contract.
            -- A single product can ship in this voucher in multiple pack sizes
            -- (e.g. 38 boxes × 368 PLUS 14 boxes × 416 — same Glamveda bottle,
            -- two different lots that the supplier sent in mixed pack sizes).
            -- Each (product, pack-size) combination is its own logical line on
            -- the voucher and must scan into its own row. Leaving per_box_qty
            -- out of the unique key causes the second pack size's scan to
            -- collide on the first row, silently dropping the line or
            -- overwriting its per_box_qty value.
            UNIQUE KEY uq_pm_xfer_item (transfer_id, side, product_id, per_box_qty),
            INDEX ix_pm_xfer_item_t (transfer_id, side)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # ── Migration: ensure the uq_pm_xfer_item unique key includes per_box_qty.
    #
    # History (read top to bottom — each step shipped to live installs):
    #   v1 (oldest):  no unique key. INSERT ... ON DUPLICATE KEY UPDATE silently
    #                 degraded to plain INSERT → duplicate rows accumulated →
    #                 reconciliation view cartesian-exploded into N×M ghost
    #                 mismatches per product.
    #   v2 (legacy):  UNIQUE KEY (transfer_id, side, product_id). Fixed the
    #                 reconcile blow-up but introduced a new bug: a single
    #                 product shipped in multiple pack sizes in one voucher
    #                 (e.g. 38 × 368 + 14 × 416) couldn't have separate lines
    #                 — the second scan tripped the unique key and either
    #                 errored or overwrote the first line's per_box_qty,
    #                 corrupting the total.
    #   v3 (this):    UNIQUE KEY (transfer_id, side, product_id, per_box_qty).
    #                 Each (product, pack-size) gets its own row, matching the
    #                 manual SELECT+ABS(per_box_qty − scanned) < 0.001 lookup
    #                 that voucher/scan_box already does. Solves both v1 and
    #                 v2 problems.
    #
    # The migration is idempotent: it inspects the current index shape and
    # acts only when something needs to change.
    try:
        cur_cols = conn.execute(
            """SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index) AS cols
               FROM information_schema.statistics
               WHERE table_schema = DATABASE()
                 AND table_name   = 'pm_transfer_items'
                 AND index_name   = 'uq_pm_xfer_item'"""
        ).fetchone()
        cur_cols_str = (cur_cols['cols'] or '').lower() if cur_cols else ''
        target_str   = 'transfer_id,side,product_id,per_box_qty'

        if cur_cols_str == target_str:
            # State (C) — already on v3. Nothing to do.
            pass
        elif cur_cols_str == 'transfer_id,side,product_id':
            # State (B) — legacy v2 key in place. Drop and recreate wider.
            # No data consolidation needed: the old key only ever allowed one
            # row per (transfer_id, side, product_id), so per_box_qty is
            # already unique within each such group by construction.
            conn.execute("ALTER TABLE pm_transfer_items DROP INDEX uq_pm_xfer_item")
            conn.execute(
                "ALTER TABLE pm_transfer_items "
                "ADD UNIQUE KEY uq_pm_xfer_item "
                "(transfer_id, side, product_id, per_box_qty)"
            )
        elif cur_cols_str == '':
            # State (A) — no unique key at all. First consolidate any
            # legacy duplicates (rows that share product + per_box_qty,
            # which IS the new uniqueness grain), then add the v3 key.
            # We deliberately group by per_box_qty too so we don't merge
            # legitimate pack-size variants into one row.
            dup_groups = conn.execute(
                """SELECT transfer_id, side, product_id, per_box_qty,
                          MIN(item_id)   AS keep_id,
                          SUM(no_of_box) AS sum_box,
                          SUM(total_qty) AS sum_qty
                   FROM pm_transfer_items
                   GROUP BY transfer_id, side, product_id, per_box_qty
                   HAVING COUNT(*) > 1"""
            ).fetchall()
            for g in dup_groups:
                conn.execute(
                    """UPDATE pm_transfer_items
                       SET no_of_box=%s, total_qty=%s
                       WHERE item_id=%s""",
                    (int(g['sum_box'] or 0), float(g['sum_qty'] or 0), g['keep_id'])
                )
                conn.execute(
                    """DELETE FROM pm_transfer_items
                       WHERE transfer_id=%s AND side=%s AND product_id=%s
                         AND ABS(per_box_qty - %s) < 0.001
                         AND item_id <> %s""",
                    (g['transfer_id'], g['side'], g['product_id'],
                     float(g['per_box_qty'] or 0), g['keep_id'])
                )
            conn.execute(
                "ALTER TABLE pm_transfer_items "
                "ADD UNIQUE KEY uq_pm_xfer_item "
                "(transfer_id, side, product_id, per_box_qty)"
            )
        else:
            # Unknown shape (someone hand-edited the index). Don't touch it —
            # log so an admin can decide. Leaving it alone is safer than
            # blindly replacing what might be intentional.
            import sys as _sys
            print(
                "[pm_stock] pm_transfer_items has unexpected uq_pm_xfer_item shape: "
                f"{cur_cols_str!r} (expected {target_str!r}). Skipping migration.",
                file=_sys.stderr
            )
    except Exception as _e:
        import sys as _sys
        print(f"[pm_stock] pm_transfer_items unique-key migration skipped: {_e}",
              file=_sys.stderr)

    # Per-item remarks: the fulfiller can note something per product line on a
    # Material OUT voucher (e.g. "short by 200, balance tomorrow"). Idempotent.
    try:
        conn.execute("ALTER TABLE pm_transfer_items ADD COLUMN remarks VARCHAR(255) DEFAULT NULL")
    except Exception:
        pass  # column already exists

    # Add 'has_discrepancy' column to pm_transfers (sticky red flag, cleared
    # only when destination user reconciles).
    try:
        conn.execute("ALTER TABLE pm_transfers ADD COLUMN has_discrepancy TINYINT(1) NOT NULL DEFAULT 0")
    except Exception:
        pass  # column already exists
    try:
        conn.execute("ALTER TABLE pm_transfers ADD COLUMN discrepancy_note VARCHAR(500) DEFAULT NULL")
    except Exception:
        pass

    # Add 'voucher_type' column to differentiate Material Out / Allotment.
    # 'transfer' covers the original cross-godown movement; 'allotment'
    # covers same-or-cross godown allotments for FG packing (which may
    # have from_godown_id == to_godown_id and skip the IN-side stock-up).
    # Old rows default to 'transfer' so existing reports keep working.
    try:
        conn.execute(
            "ALTER TABLE pm_transfers ADD COLUMN voucher_type "
            "ENUM('transfer','allotment') NOT NULL DEFAULT 'transfer'"
        )
    except Exception:
        pass  # column already exists

    # Per-user "home" godown — when a non-admin user is mapped here, every
    # voucher form they touch defaults its location field to this value and
    # becomes read-only. Admins are exempt and can override on save.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_user_home_godown (
            user_name    VARCHAR(100) NOT NULL PRIMARY KEY,
            godown_id    INT NOT NULL,
            note         VARCHAR(200) DEFAULT NULL,
            updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            updated_by   VARCHAR(100) DEFAULT NULL,
            INDEX ix_pm_uhg_godown (godown_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # Per-user access controls. Admin-managed via the "User Access Control"
    # sidebar item. Each row gates 7 broad feature categories for ONE user.
    # Defaults are ALL ALLOWED (1) — a user with no row in this table sees
    # the full UI, exactly like the legacy behaviour. Admins always bypass
    # these checks (see _user_has_access). Designed as a row-per-user table
    # (rather than a JSON blob) so we get cheap atomic per-flag updates and
    # the schema is self-describing for future audits.
    #
    # Adding a new category: extend the column list here AND add the
    # ALL_ACCESS_KEYS tuple in __init__.py AND wire it into the modal +
    # template guards. Five-step addition; the duplication is intentional
    # so the schema stays explicit rather than free-text.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_user_access (
            user_name            VARCHAR(100) NOT NULL PRIMARY KEY,
            voucher_log          TINYINT(1)   NOT NULL DEFAULT 1,
            reprint_requests     TINYINT(1)   NOT NULL DEFAULT 1,
            opening_labels       TINYINT(1)   NOT NULL DEFAULT 1,
            grn_labels           TINYINT(1)   NOT NULL DEFAULT 1,
            material_request     TINYINT(1)   NOT NULL DEFAULT 1,
            stock_pages          TINYINT(1)   NOT NULL DEFAULT 1,
            new_voucher_entries  TINYINT(1)   NOT NULL DEFAULT 1,
            material_lock        TINYINT(1)   NOT NULL DEFAULT 0,
            label_reissue        TINYINT(1)   NOT NULL DEFAULT 0,
            fifo_override        TINYINT(1)   NOT NULL DEFAULT 0,
            updated_at           DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            updated_by           VARCHAR(100) DEFAULT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    # Idempotent column adds for installs created before these features.
    # NOTE: defaults vary — sensitive control features default to 0 (no
    # access), routine features default to 1 (everyone has access by
    # default). stock_adjustment + pm_trs are routine for now — anyone
    # can submit, admin still approves separately for stock_adjustment
    # and the 24h lock applies separately for pm_trs.
    for _c, _ddl in (
        ('material_lock',     "ALTER TABLE pm_user_access ADD COLUMN material_lock TINYINT(1) NOT NULL DEFAULT 0"),
        ('label_reissue',     "ALTER TABLE pm_user_access ADD COLUMN label_reissue TINYINT(1) NOT NULL DEFAULT 0"),
        ('fifo_override',     "ALTER TABLE pm_user_access ADD COLUMN fifo_override TINYINT(1) NOT NULL DEFAULT 0"),
        ('stock_adjustment',  "ALTER TABLE pm_user_access ADD COLUMN stock_adjustment TINYINT(1) NOT NULL DEFAULT 1"),
        ('pm_trs',            "ALTER TABLE pm_user_access ADD COLUMN pm_trs TINYINT(1) NOT NULL DEFAULT 1"),
        ('bom_manage',        "ALTER TABLE pm_user_access ADD COLUMN bom_manage TINYINT(1) NOT NULL DEFAULT 0"),
        # ── Sidebar fine-grained flags (deny-all default, June 2026). ──
        # All seven default to 0 because we shifted the system to
        # deny-all: admins explicitly grant each user the sidebar items
        # they need. Existing rows get NULL on these columns and
        # _user_access_dict treats NULL as False under the new policy.
        ('combined_view',     "ALTER TABLE pm_user_access ADD COLUMN combined_view TINYINT(1) NOT NULL DEFAULT 0"),
        ('split_box',         "ALTER TABLE pm_user_access ADD COLUMN split_box TINYINT(1) NOT NULL DEFAULT 0"),
        ('products',          "ALTER TABLE pm_user_access ADD COLUMN products TINYINT(1) NOT NULL DEFAULT 0"),
        ('suppliers',         "ALTER TABLE pm_user_access ADD COLUMN suppliers TINYINT(1) NOT NULL DEFAULT 0"),
        ('voucher_settings',  "ALTER TABLE pm_user_access ADD COLUMN voucher_settings TINYINT(1) NOT NULL DEFAULT 0"),
        ('material_movement', "ALTER TABLE pm_user_access ADD COLUMN material_movement TINYINT(1) NOT NULL DEFAULT 0"),
        ('purchase_orders',   "ALTER TABLE pm_user_access ADD COLUMN purchase_orders TINYINT(1) NOT NULL DEFAULT 0"),
        ('reports',           "ALTER TABLE pm_user_access ADD COLUMN reports TINYINT(1) NOT NULL DEFAULT 0"),
        ('command_palette',   "ALTER TABLE pm_user_access ADD COLUMN command_palette TINYINT(1) NOT NULL DEFAULT 0"),
    ):
        try:
            conn.execute(_ddl)
        except Exception:
            pass

    # ── Access GROUPS (additive layer over per-user access) ─────────────
    # An admin can define a named group with its own feature toggles, then
    # assign users to it. Resolution order at access-check time:
    #   admin → all access;
    #   else per-user pm_user_access row (explicit override) wins;
    #   else the user's assigned group's access;
    #   else defaults.
    # pm_access_groups holds the same feature columns as pm_user_access so the
    # toggle UI and resolver can share the PM_USER_ACCESS_KEYS column list.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_access_groups (
            group_id             INT AUTO_INCREMENT PRIMARY KEY,
            group_name           VARCHAR(120) NOT NULL,
            voucher_log          TINYINT(1)   NOT NULL DEFAULT 1,
            reprint_requests     TINYINT(1)   NOT NULL DEFAULT 1,
            opening_labels       TINYINT(1)   NOT NULL DEFAULT 1,
            grn_labels           TINYINT(1)   NOT NULL DEFAULT 1,
            material_request     TINYINT(1)   NOT NULL DEFAULT 1,
            stock_pages          TINYINT(1)   NOT NULL DEFAULT 1,
            new_voucher_entries  TINYINT(1)   NOT NULL DEFAULT 1,
            material_lock        TINYINT(1)   NOT NULL DEFAULT 0,
            label_reissue        TINYINT(1)   NOT NULL DEFAULT 0,
            fifo_override        TINYINT(1)   NOT NULL DEFAULT 0,
            note                 VARCHAR(300) DEFAULT NULL,
            created_by           VARCHAR(100) DEFAULT NULL,
            created_at           DATETIME     DEFAULT CURRENT_TIMESTAMP,
            updated_at           DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            updated_by           VARCHAR(100) DEFAULT NULL,
            UNIQUE KEY uq_pm_group_name (group_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_access_group_members (
            user_name   VARCHAR(100) NOT NULL PRIMARY KEY,
            group_id    INT          NOT NULL,
            assigned_by VARCHAR(100) DEFAULT NULL,
            assigned_at DATETIME     DEFAULT CURRENT_TIMESTAMP,
            INDEX ix_pm_grpmem_group (group_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    # Idempotent column adds on pm_access_groups too — must mirror
    # pm_user_access so group-based access resolution works.
    for _c, _ddl in (
        ('stock_adjustment',  "ALTER TABLE pm_access_groups ADD COLUMN stock_adjustment TINYINT(1) NOT NULL DEFAULT 1"),
        ('pm_trs',            "ALTER TABLE pm_access_groups ADD COLUMN pm_trs TINYINT(1) NOT NULL DEFAULT 1"),
        ('bom_manage',        "ALTER TABLE pm_access_groups ADD COLUMN bom_manage TINYINT(1) NOT NULL DEFAULT 0"),
        # Sidebar fine-grained flags (must mirror pm_user_access).
        ('combined_view',     "ALTER TABLE pm_access_groups ADD COLUMN combined_view TINYINT(1) NOT NULL DEFAULT 0"),
        ('split_box',         "ALTER TABLE pm_access_groups ADD COLUMN split_box TINYINT(1) NOT NULL DEFAULT 0"),
        ('products',          "ALTER TABLE pm_access_groups ADD COLUMN products TINYINT(1) NOT NULL DEFAULT 0"),
        ('suppliers',         "ALTER TABLE pm_access_groups ADD COLUMN suppliers TINYINT(1) NOT NULL DEFAULT 0"),
        ('voucher_settings',  "ALTER TABLE pm_access_groups ADD COLUMN voucher_settings TINYINT(1) NOT NULL DEFAULT 0"),
        ('material_movement', "ALTER TABLE pm_access_groups ADD COLUMN material_movement TINYINT(1) NOT NULL DEFAULT 0"),
        ('purchase_orders',   "ALTER TABLE pm_access_groups ADD COLUMN purchase_orders TINYINT(1) NOT NULL DEFAULT 0"),
        ('reports',           "ALTER TABLE pm_access_groups ADD COLUMN reports TINYINT(1) NOT NULL DEFAULT 0"),
        ('command_palette',   "ALTER TABLE pm_access_groups ADD COLUMN command_palette TINYINT(1) NOT NULL DEFAULT 0"),
    ):
        try:
            conn.execute(_ddl)
        except Exception:
            pass

    # Voucher-type permissions — admin-controlled toggles that block non-admin
    # users from creating new vouchers of a given type. Keys: grn, mtv, dn,
    # opening. Default = enabled. Admins are never blocked.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_voucher_permissions (
            voucher_type VARCHAR(20)  NOT NULL PRIMARY KEY,
            enabled      TINYINT(1)   NOT NULL DEFAULT 1,
            updated_at   DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            updated_by   VARCHAR(100) DEFAULT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # Per-user command-palette usage. Used to surface "most-used" items
    # at the top of the empty palette. Schema is intentionally tiny —
    # one row per (user, action_id) pair with a hit-count and last-used
    # timestamp. The palette frontend tracks every action invocation and
    # POSTs to /api/pm_stock/palette/track which UPSERTs here. Recency
    # blends count + last_used to rank — a recently-used item beats
    # an older heavily-used one. action_id is a short string the
    # frontend defines (e.g. 'nav:stock', 'create:grn', 'open:user_access');
    # we don't validate it here so adding new actions doesn't require a
    # schema change.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_palette_usage (
            user_name    VARCHAR(100) NOT NULL,
            action_id    VARCHAR(80)  NOT NULL,
            hit_count    INT          NOT NULL DEFAULT 0,
            last_used_at DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            PRIMARY KEY (user_name, action_id),
            INDEX ix_pmpal_recency (user_name, last_used_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # Seed the four known voucher types if missing (default enabled)
    for vt in ('grn', 'mtv', 'dn', 'opening'):
        conn.execute(
            "INSERT IGNORE INTO pm_voucher_permissions (voucher_type, enabled) VALUES (%s, 1)",
            (vt,)
        )

    # ── Recycle Bin (Phase 1) ─────────────────────────────────────────────────
    # Generic soft-delete store. When a row is "deleted", we capture its full
    # state as JSON in this table and remove the original. Admins can list,
    # inspect, restore (re-INSERT), or purge (hard-delete from bin).
    #
    # Design: payload is JSON of the original row(s). For parent rows that have
    # children (e.g. GRN with items), the entire family is stored in one bin
    # entry under {"parent": {...}, "children": {"pm_grn_items": [{...}, ...]}}.
    # On restore we re-INSERT all rows, preserving original IDs.
    #
    # Phase 1 covers: pm_grn, pm_dn, pm_mtv, pm_transfers (with their items
    # and ledger txns). Phase 2 will extend to products, suppliers, brands,
    # individual ledger txns, etc.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_recycle_bin (
            bin_id        INT AUTO_INCREMENT PRIMARY KEY,
            entity_type   VARCHAR(50)  NOT NULL,
            entity_label  VARCHAR(200) DEFAULT NULL,
            entity_id     INT          DEFAULT NULL,
            payload       LONGTEXT     NOT NULL,
            payload_summary VARCHAR(500) DEFAULT NULL,
            deleted_by    VARCHAR(100) DEFAULT NULL,
            deleted_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
            reason        VARCHAR(500) DEFAULT NULL,
            restored_at   DATETIME     DEFAULT NULL,
            restored_by   VARCHAR(100) DEFAULT NULL,
            INDEX ix_pm_bin_entity (entity_type, deleted_at),
            INDEX ix_pm_bin_active (restored_at, deleted_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # ── Label Reprint Requests (Phase 1) ──────────────────────────────────
    # Workflow: regular users must request approval before reprinting labels
    # for GRN or Opening Stock vouchers. Admins approve/reject in real-time;
    # the approved request carries a single-use token the requester redeems
    # when they actually print.
    #
    # Scope:
    #   - 'voucher_grn'    : reprint all GRN labels for one GRN
    #   - 'voucher_op'     : reprint all OP labels for one OP-label batch
    #   - 'boxes'          : reprint a specific list of box codes (any source)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_label_reprint_requests (
            req_id        INT AUTO_INCREMENT PRIMARY KEY,
            scope_type    VARCHAR(30) NOT NULL,
            voucher_kind  VARCHAR(10) DEFAULT NULL,
            voucher_id    INT DEFAULT NULL,
            voucher_label VARCHAR(120) DEFAULT NULL,
            box_codes_csv TEXT DEFAULT NULL,
            requested_by  VARCHAR(100) NOT NULL,
            requested_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
            reason        VARCHAR(500) DEFAULT NULL,
            status        VARCHAR(20) NOT NULL DEFAULT 'pending',
            approved_by   VARCHAR(100) DEFAULT NULL,
            approved_at   DATETIME DEFAULT NULL,
            decided_note  VARCHAR(500) DEFAULT NULL,
            print_token   VARCHAR(64) DEFAULT NULL,
            printed_at    DATETIME DEFAULT NULL,
            printed_by    VARCHAR(100) DEFAULT NULL,
            -- Edit-mode reprint fields (added later — see ALTER below).
            -- product_id     : for OP scope, the product whose batch is being reprinted.
            --                  for GRN scope, the GRN line item's product_id.
            -- godown_id      : for OP scope, the location of the batch (NULL for GRN).
            -- new_no_of_box  : NULL means "no edit, reprint as-is".
            -- new_per_box_qty: NULL means "no edit, reprint as-is".
            -- The pair must be both set or both unset.
            product_id      INT          DEFAULT NULL,
            godown_id       INT          DEFAULT NULL,
            new_no_of_box   INT          DEFAULT NULL,
            new_per_box_qty DECIMAL(18,3) DEFAULT NULL,
            INDEX ix_pm_lrr_status (status, requested_at),
            INDEX ix_pm_lrr_user (requested_by, requested_at),
            INDEX ix_pm_lrr_voucher (voucher_kind, voucher_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    # Add new columns to existing installations idempotently (CREATE TABLE
    # IF NOT EXISTS won't add columns to a pre-existing table).
    for col_def in (
        ("product_id",      "INT          DEFAULT NULL"),
        ("godown_id",       "INT          DEFAULT NULL"),
        ("new_no_of_box",   "INT          DEFAULT NULL"),
        ("new_per_box_qty", "DECIMAL(18,3) DEFAULT NULL"),
        # Per-box selection payload for "selective reprint" requests —
        # the same shape used by api_grn_reprint_labels_selective and
        # api_op_batch_reprint_selective: a JSON array of objects of
        # form {box_id, box_seq, per_box_qty, is_new} plus an optional
        # `removed_box_ids` array. When this column is set, the redeem
        # path routes through the selective endpoint logic instead of
        # the older "edit reprint" / pure-reprint paths.
        #
        # MEDIUMTEXT (16 MB) instead of TEXT (64 KB) because reprint
        # batches for high-box-count vouchers (e.g. 871 boxes × ~70
        # chars/entry ≈ 61 KB) hit the TEXT cap and fail validation.
        # The selection JSON is bounded by the original voucher's box
        # count, so MEDIUMTEXT comfortably covers any realistic case.
        ("selections_json", "MEDIUMTEXT    DEFAULT NULL"),
    ):
        col_name, col_type = col_def
        try:
            conn.execute(f"ALTER TABLE pm_label_reprint_requests ADD COLUMN {col_name} {col_type}")
        except Exception:
            # Already exists — fine.
            pass
    # Idempotent upgrade for installs where the column was created as
    # TEXT before this fix shipped. MODIFY is a no-op if it's already
    # MEDIUMTEXT, so safe to run on every startup.
    try:
        conn.execute("ALTER TABLE pm_label_reprint_requests MODIFY COLUMN selections_json MEDIUMTEXT DEFAULT NULL")
    except Exception:
        pass

    # ── Per-box print status (child of pm_label_reprint_requests) ──────
    # New table for the multi-approval flow: when an admin approves a
    # request, one row is inserted here per box_code in the request's CSV.
    # Each row tracks whether that individual box has been printed yet.
    # A request is considered fully printed only when every child row
    # has printed_at IS NOT NULL.
    #
    # NOTE: rows are only created for requests approved AFTER this code
    # ships. Pre-existing approvals (status='approved' with no child rows)
    # continue to use the legacy "print all at once" code path — see
    # api_reprint_print for the fallback logic.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_label_reprint_box_status (
            req_id      INT NOT NULL,
            box_code    VARCHAR(120) NOT NULL,
            printed_at  DATETIME DEFAULT NULL,
            printed_by  VARCHAR(100) DEFAULT NULL,
            PRIMARY KEY (req_id, box_code),
            INDEX ix_pm_lrbs_unprinted (req_id, printed_at),
            CONSTRAINT fk_pm_lrbs_req FOREIGN KEY (req_id)
                REFERENCES pm_label_reprint_requests(req_id)
                ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    conn.commit()
    conn.close()

def ensure_pm_stock_adjustment_tables():
    """Stock Adjustment vouchers — non-admin creates pending, admin approves.

    Two tables:
      pm_stock_adjustments       — header (one per voucher)
      pm_stock_adjustment_items  — lines (multiple per voucher)

    Workflow:
      1. Requester creates voucher with status='pending' (NO ledger write yet)
      2. Admin opens pending list, reviews, hits Approve or Reject
      3. Approve: write inward/outward (godown) or pm_return/rejection
         (floor) rows to the ledger; status→'approved'
      4. Reject: status→'rejected' with admin's reason; requester can edit
         the voucher and resubmit (status→'pending' again, approval_*
         cleared)

    Single-location voucher: header carries godown_id + is_floor for the
    whole voucher; all items share that location. Each item has its own
    direction (increase/decrease), qty, and reason.

    Status transitions:
      pending → approved  (admin approve)
      pending → rejected  (admin reject)
      rejected → pending  (requester edits + resubmits)
      pending → (deleted) (requester deletes own; admin can delete any)
    """
    conn = sampling_portal.get_db_connection()
    if not conn:
        return
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_stock_adjustments (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            adj_no          VARCHAR(50)  NOT NULL UNIQUE,
            adj_date        DATE         NOT NULL,
            godown_id       INT          NOT NULL,
            is_floor        TINYINT(1)   NOT NULL DEFAULT 0,
            status          ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
            requested_by    VARCHAR(100) NOT NULL DEFAULT '',
            requested_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
            approved_by     VARCHAR(100) DEFAULT NULL,
            approved_at     DATETIME     DEFAULT NULL,
            rejected_by     VARCHAR(100) DEFAULT NULL,
            rejected_at     DATETIME     DEFAULT NULL,
            reject_reason   VARCHAR(500) DEFAULT NULL,
            voucher_remarks VARCHAR(500) DEFAULT '',
            updated_at      DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX ix_pmadj_status   (status, adj_date),
            INDEX ix_pmadj_user     (requested_by, status),
            INDEX ix_pmadj_godown   (godown_id, adj_date)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_stock_adjustment_items (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            adj_id          INT           NOT NULL,
            product_id      INT           NOT NULL,
            direction       ENUM('increase','decrease') NOT NULL,
            qty             DECIMAL(12,2) NOT NULL DEFAULT 0,
            reason          VARCHAR(500)  NOT NULL DEFAULT '',
            -- Ledger row id created at approval time (so we can locate / reverse
            -- it if the approval is ever rolled back). Either godown_txn_id is
            -- set (when the location is a regular godown) or floor_txn_id is
            -- set (when the location is the factory floor). Both NULL until
            -- approved.
            godown_txn_id   INT           DEFAULT NULL,
            floor_txn_id    INT           DEFAULT NULL,
            INDEX ix_pmadj_items_adj     (adj_id),
            INDEX ix_pmadj_items_product (product_id),
            CONSTRAINT fk_pmadj_items_hdr FOREIGN KEY (adj_id)
                REFERENCES pm_stock_adjustments(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    conn.commit()
    conn.close()

def ensure_pm_trs_tables():
    """PM Testing Requisition Slip (TRS) tables.

    Mirrors the RM-side procurement_grn_trs table but with PM-specific
    columns (box count, no batch/mfg/expiry — those aren't tracked for
    packaging materials) and lives in its own table so the RM and PM
    flows stay isolated.

    Three tables:

      pm_grn_trs
          One row per generated TRS. May aggregate multiple
          pm_grn_items lines (when user multi-selects same-product
          rows on a GRN, qty_total + no_of_box sum across them; the
          set of consumed line-ids lives in source_item_ids as JSON).

          Status lifecycle matches RM:
              Pending  → Approved   (approval_locked_at set on first
              Pending  → Rejected     non-Pending transition; 24h
              Pending  → Under Review editable window after that)

          After 24h, only an admin can change the row.

      pm_trs_observation_params_library
          QC-curated parameter dictionary used in the observation
          report. Starts empty — QC users add items as they go.

      pm_trs_observations
          One row per generated observation report.  Stores
          structured parameter rows as JSON; auto-locks when its
          parent TRS locks.

    Note: TRS row's editability is governed entirely by approval_status
    + approval_locked_at — there is no separate "trs_locked" flag.
    """
    conn = sampling_portal.get_db_connection()
    if not conn:
        return
    # ── Main TRS table ───────────────────────────────────────────────
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_grn_trs (
            id                  INT AUTO_INCREMENT PRIMARY KEY,
            trs_num             VARCHAR(60)  NOT NULL UNIQUE,
            grn_id              INT          NOT NULL,
            -- For single-line TRS this is the originating pm_grn_items.id.
            -- For aggregated multi-line TRS this stays as the FIRST line
            -- id (so existing FK-style joins still work); the full set is
            -- in source_item_ids.
            grn_item_id         INT          DEFAULT NULL,
            source_item_ids     VARCHAR(500) DEFAULT NULL,
            -- Cached header for reporting (so RM-style PDF prints don't
            -- need to re-join pm_grn for every TRS load)
            grn_num             VARCHAR(50)  NOT NULL DEFAULT '',
            grn_date            DATE         DEFAULT NULL,
            -- Material identification (product snapshot at TRS time)
            product_id          INT          DEFAULT NULL,
            material            VARCHAR(300) NOT NULL DEFAULT '',
            product_code        VARCHAR(60)  DEFAULT '',
            pm_type             VARCHAR(60)  DEFAULT '',
            -- Quantity (aggregated when multi-line)
            no_of_box           DECIMAL(12,3) DEFAULT 0,
            qty_per_pkg         DECIMAL(12,3) DEFAULT 0,
            total_qty           DECIMAL(14,3) DEFAULT 0,
            uom                 VARCHAR(20)  DEFAULT '',
            -- Supplier + previous-supplier comparison (RM pattern)
            supplier_name       VARCHAR(300) DEFAULT '',
            previous_supplier   VARCHAR(300) DEFAULT '',
            new_or_old          VARCHAR(10)  DEFAULT 'OLD',
            -- Operator-filled fields (the "missing data" modal collects
            -- these if the GRN didn't have them)
            physical_state      VARCHAR(50)  DEFAULT 'OK',
            sample_qty          DECIMAL(12,3) DEFAULT 1,
            client_name         VARCHAR(300) DEFAULT '',
            -- Authorship + approval
            generated_by        VARCHAR(100) DEFAULT '',
            generated_at        DATETIME     DEFAULT CURRENT_TIMESTAMP,
            verified_by         VARCHAR(100) DEFAULT '',
            approval_status     ENUM('Pending','Approved','Rejected','Under Review')
                                NOT NULL DEFAULT 'Pending',
            approved_by         VARCHAR(150) DEFAULT NULL,
            approval_dt         DATETIME     DEFAULT NULL,
            approval_remarks    VARCHAR(1000) DEFAULT NULL,
            -- Set when row first leaves Pending. The 24h editability
            -- window starts at this moment.
            approval_locked_at  DATETIME     DEFAULT NULL,
            -- QC observation snapshot (parameter checks done by QC at
            -- approval time). JSON list of {name, unit, spec_type, ...}.
            checked_params      TEXT         DEFAULT NULL,
            rejection_reason    VARCHAR(1000) DEFAULT NULL,
            INDEX ix_pmtrs_grn   (grn_id),
            INDEX ix_pmtrs_state (approval_status, generated_at),
            INDEX ix_pmtrs_item  (grn_item_id),
            CONSTRAINT fk_pmtrs_grn FOREIGN KEY (grn_id)
                REFERENCES pm_grn(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    # ── Observation parameter library (PM-specific) ──────────────────
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_trs_observation_params_library (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            name            VARCHAR(200) NOT NULL UNIQUE,
            unit            VARCHAR(50)  DEFAULT '',
            spec_type       ENUM('range','target','text','boolean')
                                 NOT NULL DEFAULT 'range',
            spec_from       VARCHAR(50)  DEFAULT NULL,
            spec_to         VARCHAR(50)  DEFAULT NULL,
            spec_target     VARCHAR(200) DEFAULT NULL,
            notes           VARCHAR(500) DEFAULT '',
            created_by      VARCHAR(100) DEFAULT '',
            created_at      DATETIME     DEFAULT CURRENT_TIMESTAMP,
            usage_count     INT          DEFAULT 0,
            INDEX ix_pmtolib_use (usage_count DESC)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    # ── Observation report (one per TRS, optional) ───────────────────
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_trs_observations (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            trs_id          INT          NOT NULL,
            -- JSON list of structured parameter rows. Same shape as the
            -- RM-side checked_params, but stored independently here so
            -- the QC engineer can save mid-edit without changing TRS
            -- approval state.
            params_json     MEDIUMTEXT   DEFAULT NULL,
            overall_remarks VARCHAR(2000) DEFAULT '',
            created_by      VARCHAR(100) DEFAULT '',
            created_at      DATETIME     DEFAULT CURRENT_TIMESTAMP,
            updated_at      DATETIME     DEFAULT CURRENT_TIMESTAMP
                                         ON UPDATE CURRENT_TIMESTAMP,
            -- Locked flag (mirror of parent TRS lock — denormalised so
            -- list queries don't always have to join). Recomputed on
            -- each save: True when parent TRS approval_locked_at is
            -- present AND older than 24h.
            is_locked       TINYINT(1)   NOT NULL DEFAULT 0,
            INDEX ix_pmtobs_trs (trs_id),
            CONSTRAINT fk_pmtobs_trs FOREIGN KEY (trs_id)
                REFERENCES pm_grn_trs(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # ════════════════════════════════════════════════════════════════════
    # BOM (Bill of Materials)
    # ────────────────────────────────────────────────────────────────────
    # Three-table model:
    #
    #   pm_fg_products       — Finished-goods catalogue. Separate from
    #                          pm_products (which is the raw/packaging-
    #                          material catalogue). One row per FG SKU.
    #                          Carries client_name + brand_name as plain
    #                          text (free-typed, no FK) so FG entry isn't
    #                          blocked by brand-admin gatekeeping.
    #
    #   pm_bom               — One row per FG. The HEAD pointer: holds the
    #                          current version number that bumps on every
    #                          edit. There is exactly one pm_bom row per
    #                          fg_product_id (1:1). version starts at 1.
    #
    #   pm_bom_items         — The CURRENT recipe lines. Replaced wholesale
    #                          on every edit. The previous version's lines
    #                          are snapshotted into pm_bom_history (below)
    #                          as JSON so old MRs can still recover them.
    #
    #   pm_bom_history       — Append-only audit + version archive. Stores
    #                          the full prior recipe (items_json) plus
    #                          edit metadata each time the BOM is saved.
    #                          Old MRs (which stamp source_bom_id +
    #                          source_bom_version on creation) can look
    #                          up "what did BOM #X at version V look
    #                          like?" by querying this table.
    # ════════════════════════════════════════════════════════════════════
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_fg_products (
            fg_id           INT AUTO_INCREMENT PRIMARY KEY,
            fg_code         VARCHAR(40)  NOT NULL,
            fg_name         VARCHAR(200) NOT NULL,
            brand_name      VARCHAR(120) DEFAULT '',
            client_name     VARCHAR(120) DEFAULT '',
            description     VARCHAR(500) DEFAULT '',
            is_active       TINYINT(1)   NOT NULL DEFAULT 1,
            created_by      VARCHAR(100) DEFAULT NULL,
            created_at      DATETIME     DEFAULT CURRENT_TIMESTAMP,
            updated_by      VARCHAR(100) DEFAULT NULL,
            updated_at      DATETIME     DEFAULT CURRENT_TIMESTAMP
                                         ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_fg_code (fg_code),
            INDEX ix_fg_name   (fg_name),
            INDEX ix_fg_brand  (brand_name),
            INDEX ix_fg_client (client_name)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_bom (
            bom_id          INT AUTO_INCREMENT PRIMARY KEY,
            fg_id           INT          NOT NULL,
            -- Current revision number. Starts at 1; bumps on every save
            -- of pm_bom_items. Mostly informational (the actual recipe
            -- lookup uses pm_bom_items for current and pm_bom_history
            -- for old MR replay).
            version         INT          NOT NULL DEFAULT 1,
            notes           VARCHAR(500) DEFAULT '',
            created_by      VARCHAR(100) DEFAULT NULL,
            created_at      DATETIME     DEFAULT CURRENT_TIMESTAMP,
            updated_by      VARCHAR(100) DEFAULT NULL,
            updated_at      DATETIME     DEFAULT CURRENT_TIMESTAMP
                                         ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_bom_fg (fg_id),
            CONSTRAINT fk_bom_fg FOREIGN KEY (fg_id)
                REFERENCES pm_fg_products(fg_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_bom_items (
            item_id         INT AUTO_INCREMENT PRIMARY KEY,
            bom_id          INT          NOT NULL,
            product_id      INT          NOT NULL,
            -- "Per FG unit" multiplier. 1 FG = qty_per_unit components.
            -- DECIMAL because some components might be measured in
            -- non-integer ratios (e.g. 0.5 of a sheet, 2.5 grams).
            qty_per_unit    DECIMAL(14,3) NOT NULL DEFAULT 1,
            sort_order      INT          NOT NULL DEFAULT 0,
            note            VARCHAR(200) DEFAULT '',
            INDEX ix_bomi_bom    (bom_id),
            INDEX ix_bomi_prod   (product_id),
            UNIQUE KEY uq_bom_prod (bom_id, product_id),
            CONSTRAINT fk_bomi_bom  FOREIGN KEY (bom_id)
                REFERENCES pm_bom(bom_id) ON DELETE CASCADE,
            CONSTRAINT fk_bomi_prod FOREIGN KEY (product_id)
                REFERENCES pm_products(id) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # Version archive — append-only history of every BOM save. The
    # current version's snapshot is written too (just before the new
    # items get inserted into pm_bom_items), so the history is the
    # authoritative record of what each version looked like.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_bom_history (
            history_id      INT AUTO_INCREMENT PRIMARY KEY,
            bom_id          INT          NOT NULL,
            fg_id           INT          NOT NULL,
            version         INT          NOT NULL,
            -- JSON snapshot of the items: list of
            --   { product_id, product_code, product_name, qty_per_unit,
            --     sort_order, note }
            -- product_code + name are denormalised at save time so the
            -- history stays human-readable even if the master product
            -- record is later renamed.
            items_json      MEDIUMTEXT   NOT NULL,
            notes           VARCHAR(500) DEFAULT '',
            edited_by       VARCHAR(100) DEFAULT NULL,
            edited_at       DATETIME     DEFAULT CURRENT_TIMESTAMP,
            edit_summary    VARCHAR(300) DEFAULT '',
            INDEX ix_bomh_bom (bom_id, version),
            INDEX ix_bomh_fg  (fg_id, version),
            CONSTRAINT fk_bomh_bom FOREIGN KEY (bom_id)
                REFERENCES pm_bom(bom_id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    conn.commit()
    conn.close()

def ensure_fifo_lots_table():
    """
    Lot-level FIFO tracking.

    Each "lot" is a unique (lot_kind, lot_ref) pair. lot_kind is 'grn' or 'op',
    lot_ref is the source row's primary key (pm_grn.id for GRN lots, op_seq
    for opening-stock batches). product_id pins the lot to its product so a
    multi-product GRN gets one FIFO code per product line.

    fifo_code is a single monotonically-incremented alphanumeric token of
    the form A1, A2, ... A99, B1, ... Z99, AA1, AA2, ... — one global series.
    Once assigned to a lot it never changes; reprints always show the same code.

    fifo_seq is the underlying integer the code is derived from. We carry
    both so the code can be regenerated/displayed without re-parsing the
    string.
    """
    conn = sampling_portal.get_db_connection()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_fifo_lots (
            id          INT AUTO_INCREMENT PRIMARY KEY,
            lot_kind    ENUM('grn','op') NOT NULL,
            lot_ref     INT          NOT NULL,
            product_id  INT          NOT NULL,
            fifo_seq    INT          NOT NULL,
            fifo_code   VARCHAR(16)  NOT NULL,
            assigned_at DATETIME     DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY uq_pm_fifo_lot (lot_kind, lot_ref, product_id),
            UNIQUE KEY uq_pm_fifo_seq (fifo_seq),
            INDEX ix_pm_fifo_product (product_id, fifo_seq)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    conn.commit()
    conn.close()


def ensure_fifo_override_requests_table():
    """
    FIFO override approval workflow.

    When a non-admin scans an OUT box that violates FIFO (a newer lot while
    an older lot still has stock at the source), they can't force it through
    like an admin can. Instead they raise a *request* here; an admin
    approves or rejects it. An approved request grants that one user a
    SINGLE-USE pass to re-scan that EXACT box — they re-scan and the OUT
    completes. The pass is consumed (status -> 'used') the moment the box
    is successfully scanned out.

    Lifecycle:
        pending  -> approved -> used      (happy path)
        pending  -> rejected              (admin says no)
        approved -> expired               (housekeeping: box left source by
                                           other means before re-scan)

    One pending request per (requested_by, transfer, box) at a time. The
    snapshot columns (scanned_fifo_code, oldest_*) capture the violation at
    request time so the admin sees exactly what the operator saw, even if
    stock shifts before the decision.
    """
    conn = sampling_portal.get_db_connection()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_fifo_override_requests (
            req_id            INT AUTO_INCREMENT PRIMARY KEY,
            transfer_id       INT          NOT NULL,
            transfer_no       VARCHAR(64)  DEFAULT NULL,
            box_id            INT          NOT NULL,
            box_code          VARCHAR(120) NOT NULL,
            product_id        INT          DEFAULT NULL,
            product_name      VARCHAR(500) DEFAULT NULL,
            from_godown_id    INT          DEFAULT NULL,
            -- Violation snapshot (what the operator saw at request time)
            scanned_fifo_code VARCHAR(16)  DEFAULT NULL,
            oldest_fifo_code  VARCHAR(16)  DEFAULT NULL,
            oldest_voucher    VARCHAR(64)  DEFAULT NULL,
            oldest_supplier   VARCHAR(255) DEFAULT NULL,
            oldest_date       VARCHAR(20)  DEFAULT NULL,
            oldest_box_count  INT          DEFAULT 0,
            oldest_total_qty  DECIMAL(18,3) DEFAULT 0,
            -- Workflow
            requested_by      VARCHAR(100) NOT NULL,
            requested_at      DATETIME     DEFAULT CURRENT_TIMESTAMP,
            reason            VARCHAR(500) DEFAULT NULL,
            status            VARCHAR(20)  NOT NULL DEFAULT 'pending',
            decided_by        VARCHAR(100) DEFAULT NULL,
            decided_at        DATETIME     DEFAULT NULL,
            decided_note      VARCHAR(500) DEFAULT NULL,
            used_at           DATETIME     DEFAULT NULL,
            INDEX ix_pm_for_status (status, requested_at),
            INDEX ix_pm_for_user   (requested_by, requested_at),
            INDEX ix_pm_for_box    (transfer_id, box_id, status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    conn.commit()
    conn.close()


def ensure_pm_material_lock_table():
    """Material Lock feature.

    A Manager (or admin) can LOCK or ALLOW a SPECIFIC packaging-material item
    (product) so it cannot (or can) be scanned into a Material OUT voucher at a
    chosen location. This is INDEPENDENT of FIFO — FIFO ordering/override never
    interferes with a lock decision.

    Each rule targets ONE product and has:
      • product_id  the specific item the rule applies to (required)
      • mode        'block' (locked — can't OUT) | 'allow' (explicitly permitted)
      • param_type  'before_date' (matches that item's lots whose entry date is
                    before cutoff_date — OPENING STOCK counts as before any date)
                    'grn'         (matches that item on one specific GRN)
      • godown_id   the location the rule applies to; NULL = all locations
      • cutoff_date for param_type='before_date'
      • grn_id      for param_type='grn'
      • is_active   toggle without deleting

    Evaluation at OUT-scan time (see _material_lock_check):
      For the scanned box's product, a box is BLOCKED if it matches at least one
      active 'block' rule for its location AND does not match any active 'allow'
      rule for its location. (allow overrides block — lets a manager carve out
      an exception for the same item.)
    """
    conn = sampling_portal.get_db_connection()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_material_locks (
            lock_id      INT AUTO_INCREMENT PRIMARY KEY,
            product_id   INT          NOT NULL,
            product_name VARCHAR(500) DEFAULT NULL,
            mode         VARCHAR(10)  NOT NULL DEFAULT 'block',
            param_type   VARCHAR(20)  NOT NULL,
            godown_id    INT          DEFAULT NULL,
            cutoff_date  DATE         DEFAULT NULL,
            grn_id       INT          DEFAULT NULL,
            grn_no       VARCHAR(64)  DEFAULT NULL,
            note         VARCHAR(500) DEFAULT NULL,
            is_active    TINYINT(1)   NOT NULL DEFAULT 1,
            created_by   VARCHAR(100) NOT NULL,
            created_at   DATETIME     DEFAULT CURRENT_TIMESTAMP,
            updated_by   VARCHAR(100) DEFAULT NULL,
            updated_at   DATETIME     DEFAULT NULL,
            INDEX ix_pmlock_active (is_active, product_id, godown_id),
            INDEX ix_pmlock_grn    (grn_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    # Idempotent add for installs created before product-scoping.
    for col_name, col_type in (
        ('product_id',   'INT NOT NULL DEFAULT 0'),
        ('product_name', 'VARCHAR(500) DEFAULT NULL'),
    ):
        try:
            conn.execute("ALTER TABLE pm_material_locks ADD COLUMN " + col_name + " " + col_type)
        except Exception:
            pass
    conn.commit()
    conn.close()


def _material_lock_check(conn, *, product_id, godown_id, grn_id, grn_date, is_opening=False):
    """Decide whether a box may be OUT-scanned, per the Material Lock rules.

    Inputs describe the box being scanned: its product (product_id), current
    location (godown_id), its GRN (grn_id) and that GRN's date (grn_date), and
    whether it's an opening-stock box (is_opening — no GRN).

    Returns (blocked: bool, reason: str|None). FIFO is NOT consulted here.

    Logic: only rules for THIS product and this location (rule.godown_id IS
    NULL → global, or equals the box's godown) are considered. The box is
    blocked if any 'block' rule matches it, UNLESS an 'allow' rule also matches
    (allow wins).

    Date rule semantics: 'before_date' matches when the material's ENTRY date
    is before the cutoff. Opening stock has no GRN date and is treated as the
    OLDEST possible stock, so it ALWAYS counts as "before" any cutoff date.
    """
    if not product_id:
        return (False, None)
    try:
        rules = conn.execute(
            """SELECT mode, param_type, cutoff_date, grn_id, grn_no
               FROM pm_material_locks
               WHERE is_active=1
                 AND product_id=%s
                 AND (godown_id IS NULL OR godown_id=%s)""",
            (product_id, godown_id)
        ).fetchall()
    except Exception:
        return (False, None)        # never hard-fail a scan on lock-table error
    if not rules:
        return (False, None)

    bdate = str(grn_date)[:10] if grn_date is not None else None
    # An opening-stock box (no GRN) is the oldest stock → always "before" date.
    opening = bool(is_opening) or (grn_id is None)

    def _matches(r):
        pt = r['param_type']
        if pt == 'grn':
            return (r['grn_id'] is not None and grn_id is not None
                    and int(r['grn_id']) == int(grn_id))
        if pt == 'before_date':
            if not r['cutoff_date']:
                return False
            if opening:
                return True                     # opening stock is before any date
            if not bdate:
                return False
            return bdate < str(r['cutoff_date'])[:10]
        return False

    for r in rules:
        if r['mode'] == 'allow' and _matches(r):
            return (False, None)        # explicit allow overrides any block
    for r in rules:
        if r['mode'] == 'block' and _matches(r):
            if r['param_type'] == 'grn':
                why = f"GRN {r['grn_no'] or r['grn_id']} is locked for Material OUT"
            else:
                why = f"Material entered before {str(r['cutoff_date'])[:10]} is locked for Material OUT"
            return (True, why)
    return (False, None)


def ensure_label_reissue_requests_table():
    """
    Replacement-label (QR reissue) approval workflow.

    When a printed QR is damaged / won't scan, a non-admin requests a fresh
    label for that box. An admin approves; ON APPROVAL the box is stamped
    with a brand-new (shorter) short_code via _reissue_box_short_code and the
    new code is recorded here. The requester then prints the replacement
    label from "My Reissue Requests" (marking it printed).

    Lifecycle:
        pending  -> approved -> printed     (happy path)
        pending  -> rejected
    """
    conn = sampling_portal.get_db_connection()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_label_reissue_requests (
            req_id        INT AUTO_INCREMENT PRIMARY KEY,
            box_id        INT          NOT NULL,
            box_code      VARCHAR(120) DEFAULT NULL,
            old_short_code VARCHAR(16) DEFAULT NULL,
            new_short_code VARCHAR(16) DEFAULT NULL,
            product_id    INT          DEFAULT NULL,
            product_name  VARCHAR(500) DEFAULT NULL,
            grn_no        VARCHAR(64)  DEFAULT NULL,
            requested_by  VARCHAR(100) NOT NULL,
            requested_at  DATETIME     DEFAULT CURRENT_TIMESTAMP,
            reason        VARCHAR(500) DEFAULT NULL,
            status        VARCHAR(20)  NOT NULL DEFAULT 'pending',
            decided_by    VARCHAR(100) DEFAULT NULL,
            decided_at    DATETIME     DEFAULT NULL,
            decided_note  VARCHAR(500) DEFAULT NULL,
            printed_at    DATETIME     DEFAULT NULL,
            printed_by    VARCHAR(100) DEFAULT NULL,
            old_per_box_qty DECIMAL(12,3) DEFAULT NULL,
            new_per_box_qty DECIMAL(12,3) DEFAULT NULL,
            old_godown_id   INT DEFAULT NULL,
            new_godown_id   INT DEFAULT NULL,
            INDEX ix_pm_lreq_status (status, requested_at),
            INDEX ix_pm_lreq_user   (requested_by, requested_at),
            INDEX ix_pm_lreq_box    (box_id, status)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    # Idempotent column adds for installs created before later features.
    for col_name, col_type in (
        ('old_per_box_qty', 'DECIMAL(12,3) DEFAULT NULL'),
        ('new_per_box_qty', 'DECIMAL(12,3) DEFAULT NULL'),
        ('old_godown_id',   'INT DEFAULT NULL'),
        ('new_godown_id',   'INT DEFAULT NULL'),
    ):
        try:
            conn.execute("ALTER TABLE pm_label_reissue_requests ADD COLUMN " + col_name + " " + col_type)
        except Exception:
            pass
    conn.commit()
    conn.close()


def _fifo_override_find_approved(conn, transfer_id, box_id, user):
    """Return the req_id of an APPROVED, unused FIFO-override request for
    this (transfer, box, user), or None. Used by the OUT scan path to let a
    non-admin push a box through after an admin has signed off.

    Single-use: the caller marks it 'used' once the scan succeeds.
    """
    if not transfer_id or not box_id or not user:
        return None
    try:
        r = conn.execute(
            """SELECT req_id FROM pm_fifo_override_requests
               WHERE transfer_id=%s AND box_id=%s AND requested_by=%s
                 AND status='approved'
               ORDER BY decided_at DESC LIMIT 1""",
            (int(transfer_id), int(box_id), user)
        ).fetchone()
    except Exception:
        return None
    return int(r['req_id']) if r else None


def _fifo_override_mark_used(conn, req_id, user=None):
    """Mark an approved FIFO-override request as consumed. Caller's
    transaction; no commit here."""
    if not req_id:
        return
    try:
        conn.execute(
            """UPDATE pm_fifo_override_requests
               SET status='used', used_at=NOW()
               WHERE req_id=%s AND status='approved'""",
            (int(req_id),)
        )
    except Exception:
        pass


def ensure_pm_settings_table():
    """
    Module-level key/value settings table. Holds toggleable runtime
    configuration that admins can change from the UI without code edits.

    Current keys:
      fifo_enabled         '1' | '0'  → master switch for FIFO enforcement
      fifo_start_date      'YYYY-MM-DD' or NULL
                           If set, FIFO checks ignore lots created BEFORE
                           this date — i.e. only newer stock is enforced.
                           Set via the "Reset FIFO from now" button.

    The table is intentionally flat (key → value strings) because the
    settings are infrequent and admin-curated. Don't shoehorn anything
    transactional here.
    """
    conn = sampling_portal.get_db_connection()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_settings (
            setting_key   VARCHAR(64)  NOT NULL PRIMARY KEY,
            setting_value VARCHAR(255) DEFAULT NULL,
            updated_by    VARCHAR(64)  DEFAULT NULL,
            updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP
                                       ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)
    # Seed defaults if missing — FIFO ON, no start-date filter.
    conn.execute("""
        INSERT IGNORE INTO pm_settings (setting_key, setting_value)
        VALUES ('fifo_enabled', '1'),
               ('fifo_start_date', NULL)
    """)
    conn.commit()
    conn.close()


def _setting_get(conn, key, default=None):
    """Read a single setting value. Returns the string value or `default`
    if the key isn't present."""
    try:
        r = conn.execute(
            "SELECT setting_value FROM pm_settings WHERE setting_key=%s",
            (key,)
        ).fetchone()
    except Exception:
        return default
    if not r: return default
    v = r['setting_value']
    return v if v is not None else default


def _setting_set(conn, key, value, user=None):
    """Upsert a setting. Caller's transaction; no commit here."""
    if user is None:
        try: user = _user()
        except Exception: user = ''
    conn.execute("""
        INSERT INTO pm_settings (setting_key, setting_value, updated_by)
        VALUES (%s, %s, %s)
        ON DUPLICATE KEY UPDATE
            setting_value = VALUES(setting_value),
            updated_by    = VALUES(updated_by)
    """, (key, value, user))


def _fifo_is_enabled(conn):
    """True if FIFO enforcement is currently ON. Default ON if unset."""
    return _setting_get(conn, 'fifo_enabled', '1') != '0'


def _fifo_start_date(conn):
    """Return YYYY-MM-DD string or None. Used by _fifo_check_oldest to
    skip lots assigned before this date."""
    v = _setting_get(conn, 'fifo_start_date', None)
    if not v: return None
    s = str(v).strip()
    return s if s else None

AUDIT_REVERSAL_SAFE  = 'safe'

AUDIT_REVERSAL_GATED = 'gated'

AUDIT_REVERSAL_FINAL = 'final'

AUDIT_ACTIONS = {
    # Products
    'product.create':         AUDIT_REVERSAL_SAFE,
    'product.update':         AUDIT_REVERSAL_SAFE,
    'product.delete':         AUDIT_REVERSAL_GATED,   # affects opening stock
    'product.threshold':      AUDIT_REVERSAL_SAFE,
    'product.brand_assign':   AUDIT_REVERSAL_SAFE,
    'product.code_regen':     AUDIT_REVERSAL_SAFE,
    'product.opening_edit':   AUDIT_REVERSAL_GATED,   # adjusts stock
    # GRN
    'grn.create':             AUDIT_REVERSAL_GATED,
    'grn.update':             AUDIT_REVERSAL_GATED,
    'grn.delete':             AUDIT_REVERSAL_GATED,
    'grn.line_edit':          AUDIT_REVERSAL_GATED,   # qty / box / per_box change
    # MTV / transfers
    'mtv.create':             AUDIT_REVERSAL_GATED,
    'mtv.update':             AUDIT_REVERSAL_GATED,
    'mtv.delete':             AUDIT_REVERSAL_GATED,
    'transfer.create':        AUDIT_REVERSAL_GATED,
    'transfer.scan_out':      AUDIT_REVERSAL_GATED,
    'transfer.scan_in':       AUDIT_REVERSAL_GATED,
    'transfer.confirm':       AUDIT_REVERSAL_FINAL,
    'transfer.fifo_override': AUDIT_REVERSAL_FINAL,
    'fifo_override.request':  AUDIT_REVERSAL_SAFE,
    'fifo_override.approve':  AUDIT_REVERSAL_FINAL,
    'fifo_override.reject':   AUDIT_REVERSAL_FINAL,
    'fifo_override.used':     AUDIT_REVERSAL_FINAL,
    'transfer.discrepancy':   AUDIT_REVERSAL_FINAL,
    # Floor / godown txns
    'godown_txn.create':      AUDIT_REVERSAL_GATED,
    'godown_txn.delete':      AUDIT_REVERSAL_GATED,
    'godown_txn.reverse':     AUDIT_REVERSAL_FINAL,   # the reversal itself
    'floor_txn.create':       AUDIT_REVERSAL_GATED,
    'floor_txn.delete':       AUDIT_REVERSAL_GATED,
    # Admin / config
    'user_home.set':          AUDIT_REVERSAL_SAFE,
    'user_home.delete':       AUDIT_REVERSAL_SAFE,
    'voucher_seq.update':     AUDIT_REVERSAL_SAFE,
    'fifo.settings_update':   AUDIT_REVERSAL_SAFE,
    # Transfer voucher admin actions
    'transfer.admin_edit':    AUDIT_REVERSAL_GATED,    # cascading edit; requires manual review to undo
    'transfer.admin_delete':  AUDIT_REVERSAL_GATED,    # soft-delete with stock reversal
    'transfer.reconcile':     AUDIT_REVERSAL_FINAL,    # reconcile with stock postings — not auto-reversible
    # Box-level operations
    'box.split':              AUDIT_REVERSAL_GATED,    # parent superseded + children created — undo via merge (future)
    'box.reissue_label':      AUDIT_REVERSAL_SAFE,     # fresh short_code + replacement label; old QR retired
    'box.group_create':       AUDIT_REVERSAL_GATED,    # boxes bundled into a lot
    'box.group_break':        AUDIT_REVERSAL_GATED,    # group dissolved back into individual boxes
    'box.group_scan':         AUDIT_REVERSAL_SAFE,     # group scanned for OUT/IN — fan-out wrapper around individual scans
    # Labels / OP
    'op.create':              AUDIT_REVERSAL_GATED,
    'op.reprint_request':     AUDIT_REVERSAL_SAFE,
    'op.reprint_approve':     AUDIT_REVERSAL_FINAL,
    'op.reprint_reject':      AUDIT_REVERSAL_FINAL,
    'label.print':            AUDIT_REVERSAL_FINAL,   # physical event
    # Stock adjustment workflow — non-admin creates pending, admin acts
    'stock_adj.create':       AUDIT_REVERSAL_SAFE,    # pending; no ledger effect yet
    'stock_adj.update':       AUDIT_REVERSAL_SAFE,    # edit own pending/rejected
    'stock_adj.delete':       AUDIT_REVERSAL_SAFE,    # delete own pending
    'stock_adj.approve':      AUDIT_REVERSAL_GATED,   # ledger rows written
    'stock_adj.reject':       AUDIT_REVERSAL_SAFE,    # no ledger effect
    'stock_adj.resubmit':     AUDIT_REVERSAL_SAFE,    # rejected → pending
    # PM TRS (testing requisition slip) lifecycle
    'pm_trs.generate':        AUDIT_REVERSAL_SAFE,    # creation; reversible by delete
    'pm_trs.update':          AUDIT_REVERSAL_SAFE,    # pre-approval edit
    'pm_trs.delete':          AUDIT_REVERSAL_SAFE,    # delete pre-approval
    'pm_trs.approve':         AUDIT_REVERSAL_GATED,   # QC decision
    'pm_trs.reject':          AUDIT_REVERSAL_GATED,   # QC decision
    'pm_trs.observation':     AUDIT_REVERSAL_SAFE,    # QC saves observation report
    'pm_trs.admin_override':  AUDIT_REVERSAL_FINAL,   # admin edits past 24h lock
    # Reversal entries (when something IS reversed)
    'audit.reversed':         AUDIT_REVERSAL_FINAL,
}

def ensure_audit_tables():
    """
    Master audit-log table + label-print-log table.

    pm_audit_log: every state-changing action across PM Stock.
    pm_label_print_log: every label-print event from now on. Counts at the
        per-print level; one row per print run, with how many labels were
        on it. Older prints (before this table existed) aren't here — the
        report shows that explicitly.
    """
    conn = sampling_portal.get_db_connection()

    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_audit_log (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            ts              DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
            user_name       VARCHAR(64)   NOT NULL DEFAULT '',
            action          VARCHAR(48)   NOT NULL,
            entity          VARCHAR(48)   NOT NULL,
            entity_id       VARCHAR(64)   NOT NULL DEFAULT '',
            summary         VARCHAR(500)  NOT NULL DEFAULT '',
            before_json     MEDIUMTEXT,
            after_json      MEDIUMTEXT,
            route_path      VARCHAR(200)  NOT NULL DEFAULT '',
            reversal_class  ENUM('safe','gated','final') NOT NULL DEFAULT 'final',
            reversed_at     DATETIME      DEFAULT NULL,
            reversed_by     VARCHAR(64)   DEFAULT NULL,
            reversal_audit_id INT          DEFAULT NULL,
            INDEX ix_pm_audit_ts (ts),
            INDEX ix_pm_audit_user (user_name, ts),
            INDEX ix_pm_audit_entity (entity, entity_id),
            INDEX ix_pm_audit_action (action, ts),
            INDEX ix_pm_audit_reversal (reversal_class, reversed_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    conn.execute("""
        CREATE TABLE IF NOT EXISTS pm_label_print_log (
            id              INT AUTO_INCREMENT PRIMARY KEY,
            ts              DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
            user_name       VARCHAR(64)   NOT NULL DEFAULT '',
            print_kind      ENUM('grn_fresh','grn_reprint','grn_selective','op_fresh','op_reprint','op_selective','dn_fresh','manual') NOT NULL,
            scope_type      VARCHAR(20)   NOT NULL DEFAULT '',
            voucher_kind    VARCHAR(20)   NOT NULL DEFAULT '',
            voucher_id      INT           DEFAULT NULL,
            voucher_no      VARCHAR(64)   NOT NULL DEFAULT '',
            product_id      INT           DEFAULT NULL,
            label_count     INT           NOT NULL DEFAULT 0,
            box_codes_json  MEDIUMTEXT,
            request_id      INT           DEFAULT NULL,
            INDEX ix_pm_lpl_ts (ts),
            INDEX ix_pm_lpl_user (user_name, ts),
            INDEX ix_pm_lpl_kind (print_kind, ts),
            INDEX ix_pm_lpl_voucher (voucher_kind, voucher_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    """)

    # Retention: purge audit + label-print rows older than 90 days.
    # Idempotent — runs on every module import. Cheap because indexed.
    try:
        conn.execute("DELETE FROM pm_audit_log WHERE ts < (NOW() - INTERVAL 90 DAY)")
        conn.execute("DELETE FROM pm_label_print_log WHERE ts < (NOW() - INTERVAL 90 DAY)")
    except Exception:
        pass

    conn.commit()
    conn.close()

def _audit_record(conn, *, action, entity, entity_id='', summary='',
                  before=None, after=None, user=None, route=None,
                  reversal_class=None):
    """
    Record one audit event. Caller already holds an open `conn`; we don't
    commit here — let the caller commit as part of the surrounding
    transaction so the audit row and the actual change are atomic.

    `before` and `after` may be dicts; they're JSON-encoded. Pass None
    for actions where there's no meaningful before-state (creates) or
    after-state (deletes).

    `reversal_class` defaults to whatever the AUDIT_ACTIONS table says
    for this `action`. Override only if a specific call has different
    reversibility (rare).

    Returns the inserted audit_log id (caller can ignore).
    """
    import json as _json
    if reversal_class is None:
        reversal_class = AUDIT_ACTIONS.get(action, AUDIT_REVERSAL_FINAL)
    if reversal_class not in ('safe', 'gated', 'final'):
        reversal_class = AUDIT_REVERSAL_FINAL

    if user is None:
        try: user = _user()
        except Exception: user = ''

    if route is None:
        try:
            from flask import request as _rq
            route = (_rq.path or '')[:200]
        except Exception:
            route = ''

    def _ser(o):
        if o is None: return None
        try:
            return _json.dumps(o, default=str, ensure_ascii=False)[:60000]
        except Exception:
            return _json.dumps({'_unserialisable': str(type(o))})

    cur = conn.execute(
        """INSERT INTO pm_audit_log
             (user_name, action, entity, entity_id, summary,
              before_json, after_json, route_path, reversal_class)
           VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
        (
            (user or '')[:64],
            action[:48],
            entity[:48],
            str(entity_id or '')[:64],
            (summary or '')[:500],
            _ser(before),
            _ser(after),
            (route or '')[:200],
            reversal_class,
        )
    )
    return getattr(cur, 'lastrowid', None)

def _label_print_record(conn, *, print_kind, voucher_kind='', voucher_id=None,
                        voucher_no='', product_id=None, label_count=0,
                        box_codes=None, scope_type='', request_id=None,
                        user=None):
    """
    Record one label-print event. Same atomic-with-caller transaction
    contract as _audit_record(). Idempotent enough that a duplicate
    insert isn't a problem — overcounting by 1 is preferable to losing
    a print.
    """
    import json as _json
    if user is None:
        try: user = _user()
        except Exception: user = ''
    bx = None
    if box_codes:
        try: bx = _json.dumps(list(box_codes), ensure_ascii=False)[:60000]
        except Exception: bx = None
    try:
        conn.execute(
            """INSERT INTO pm_label_print_log
                 (user_name, print_kind, scope_type, voucher_kind, voucher_id,
                  voucher_no, product_id, label_count, box_codes_json, request_id)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""",
            (
                (user or '')[:64],
                (print_kind or 'manual')[:24],
                (scope_type or '')[:20],
                (voucher_kind or '')[:20],
                int(voucher_id) if voucher_id else None,
                (voucher_no or '')[:64],
                int(product_id) if product_id else None,
                int(label_count or 0),
                bx,
                int(request_id) if request_id else None,
            )
        )
    except Exception as _e:
        # Audit/print logging is never fatal to the operation. Log + continue.
        import sys as _sys
        print(f"[pm_stock_routes] _label_print_record failed: {_e}", file=_sys.stderr)

def _fifo_seq_to_code(seq):
    """Convert a 1-based monotonic sequence to A1..A99, B1..Z99, AA1..ZZ99 etc.
    Each "letter slot" holds 99 codes (1-99). After Z99 we use AA1..AA99,
    AB1.., ..., AZ99, BA1.., ..., ZZ99, then AAA1..., and so on.
    """
    if seq is None or seq < 1:
        return ''
    n = int(seq) - 1
    letter_slot, num_in_slot = divmod(n, 99)
    # Convert letter_slot (0,1,2,...) to base-26 letters: 0='A', 1='B', ..., 25='Z',
    # 26='AA', 27='AB', ..., 51='AZ', 52='BA', ..., 701='ZZ', 702='AAA', ...
    letters = ''
    s = letter_slot
    while True:
        letters = chr(ord('A') + (s % 26)) + letters
        s = s // 26 - 1
        if s < 0:
            break
    return f"{letters}{num_in_slot + 1}"

def _next_fifo_seq(conn):
    """Return the next monotonic FIFO seq (1, 2, 3, ...). Locks via INSERT
    contention on the unique key — caller wraps in a transaction."""
    row = conn.execute(
        "SELECT COALESCE(MAX(fifo_seq), 0) AS m FROM pm_fifo_lots"
    ).fetchone()
    return int((row or {}).get('m') or 0) + 1

def _get_or_assign_fifo(conn, lot_kind, lot_ref, product_id):
    """Idempotently assign (or fetch) a FIFO code for a (lot_kind, lot_ref,
    product_id) triple. Returns dict {fifo_seq, fifo_code}. Safe to call
    multiple times — the unique key prevents duplicate assignment.
    Caller should commit after invocation."""
    if not product_id or not lot_ref or lot_kind not in ('grn', 'op'):
        return {'fifo_seq': 0, 'fifo_code': ''}
    existing = conn.execute(
        """SELECT fifo_seq, fifo_code FROM pm_fifo_lots
           WHERE lot_kind=%s AND lot_ref=%s AND product_id=%s LIMIT 1""",
        (lot_kind, int(lot_ref), int(product_id))
    ).fetchone()
    if existing:
        return {'fifo_seq': int(existing['fifo_seq']),
                'fifo_code': existing['fifo_code'] or ''}
    # Allocate next seq under unique-key protection
    for _attempt in range(5):
        seq  = _next_fifo_seq(conn)
        code = _fifo_seq_to_code(seq)
        try:
            conn.execute(
                """INSERT INTO pm_fifo_lots (lot_kind, lot_ref, product_id, fifo_seq, fifo_code)
                   VALUES (%s,%s,%s,%s,%s)""",
                (lot_kind, int(lot_ref), int(product_id), seq, code)
            )
            return {'fifo_seq': seq, 'fifo_code': code}
        except Exception:
            # Race: another caller grabbed the same seq. Retry.
            continue
    # Final fallback: return seq=0 so we don't bomb the caller.
    return {'fifo_seq': 0, 'fifo_code': ''}

def _fifo_check_oldest(conn, product_id, godown_id, scanned_box_id):
    """
    For Material OUT scanning: enforce FIFO by checking whether the scanned
    box belongs to the OLDEST in-stock lot for this product at this source
    location.

    Returns:
      None if FIFO is OK (scanned box is from the oldest pending lot, or
        no FIFO records exist for this product, or the scanned box has no
        FIFO seq — legacy data).
      dict with violation details otherwise:
        {
          'scanned_fifo_code': str,
          'scanned_fifo_seq':  int,
          'scanned_voucher':   str (the GRN no of the scanned box's lot,
                                    e.g. 'PM-GRN/0185/26-27'),
          'scanned_supplier':  str (supplier on that GRN, may be ''),
          'scanned_date':      str ('YYYY-MM-DD' — grn_date of scanned lot),
          'oldest_fifo_code':  str,
          'oldest_fifo_seq':   int,
          'oldest_lot_kind':   str ('grn' | 'op'),
          'oldest_lot_ref':    int,
          'oldest_voucher':    str (e.g. 'PM-GRN/0049/26-27' or 'PM-OP/0061'),
          'oldest_supplier':   str (GRN supplier or '' for OP),
          'oldest_date':       str ('YYYY-MM-DD'),
          'oldest_box_count':  int (# boxes from that lot still in_stock here),
          'oldest_total_qty':  float,
        }

    Logic:
      - For the scanned box's product_id, look up all FIFO lots that have
        AT LEAST ONE box currently {current_godown_id=godown_id,
        current_status='in_stock'}. Sort by fifo_seq ASC.
      - The first row in that ordering is "the oldest pending lot".
      - If the scanned box's fifo_seq matches the oldest's seq → OK.
      - Otherwise → violation; build the details dict.
    """
    if not product_id or not godown_id or not scanned_box_id:
        return None

    # ── Settings short-circuits ──────────────────────────────────────────
    # 1) If FIFO enforcement is disabled globally, never raise a violation.
    # 2) If a fifo_start_date is set, lots assigned BEFORE that date are
    #    not enforced — neither as the "scanned" nor as the "oldest" candidate.
    # Both are admin-controlled via /api/pm_stock/settings/fifo.
    try:
        if not _fifo_is_enabled(conn):
            return None
    except Exception:
        pass
    fifo_start = None
    try:
        fifo_start = _fifo_start_date(conn)   # 'YYYY-MM-DD' or None
    except Exception:
        fifo_start = None

    # Find FIFO seq of the scanned box (joined to pm_fifo_lots through
    # pm_boxes' grn_id/grn_no — boxes from a GRN have non-zero grn_id;
    # boxes from an OP batch have grn_id=0 and grn_no like 'PM-OP/0061').
    scanned = conn.execute("""
        SELECT b.box_id, b.product_id, b.grn_id, b.grn_no,
               COALESCE(fl_g.fifo_seq, fl_o.fifo_seq, 0)  AS fifo_seq,
               COALESCE(fl_g.fifo_code, fl_o.fifo_code, '') AS fifo_code,
               COALESCE(fl_g.assigned_at, fl_o.assigned_at)  AS lot_assigned_at
        FROM pm_boxes b
        LEFT JOIN pm_fifo_lots fl_g
               ON fl_g.lot_kind='grn' AND fl_g.lot_ref=b.grn_id
              AND fl_g.product_id=b.product_id
        LEFT JOIN pm_fifo_lots fl_o
               ON fl_o.lot_kind='op'
              AND fl_o.lot_ref=CAST(SUBSTRING_INDEX(b.grn_no,'/',-1) AS UNSIGNED)
              AND b.grn_no LIKE 'PM-OP/%%'
              AND fl_o.product_id=b.product_id
        WHERE b.box_id=%s LIMIT 1
    """, (scanned_box_id,)).fetchone()
    if not scanned or not scanned['fifo_seq']:
        # Box has no FIFO assignment — legacy data, allow the scan.
        return None

    # FIFO applies ONLY to GRN-generated boxes. Opening-stock boxes
    # (grn_id=0 / grn_no like 'PM-OP/...') are exempt: they can be scanned
    # out in any order and are never blocked by FIFO.
    _scanned_is_op = (
        (not scanned.get('grn_id'))
        and str(scanned.get('grn_no') or '').upper().startswith('PM-OP/')
    )
    if _scanned_is_op:
        return None

    # If FIFO start date is set and this box's lot was assigned before
    # the cutoff, treat the lot as "outside FIFO scope" and let the scan
    # through unconditionally. Same effect as no FIFO record at all.
    if fifo_start and scanned.get('lot_assigned_at'):
        try:
            assigned_str = str(scanned['lot_assigned_at'])[:10]
            if assigned_str < fifo_start:
                return None
        except Exception:
            pass

    scanned_seq = int(scanned['fifo_seq'])

    # Oldest in-stock FIFO lot for this product at this godown.
    # We aggregate boxes by FIFO lot, count those still in_stock at this
    # location, and pick the lowest fifo_seq with a positive count.
    #
    # FIFO is enforced ONLY across GRN lots — opening-stock ('op') lots are
    # excluded entirely, so they never act as the blocking "oldest" lot. This
    # means GRN boxes follow FIFO amongst themselves, while opening stock sits
    # outside FIFO (scannable in any order, never blocks a GRN box).
    #
    # When fifo_start is set, exclude lots assigned before that date —
    # they're treated as "out of FIFO scope" (legacy stock the admin
    # explicitly chose not to enforce). Boxes from those lots can still
    # be scanned out, just without FIFO blocking.
    sql = """
        SELECT fl.fifo_seq, fl.fifo_code, fl.lot_kind, fl.lot_ref,
               COUNT(b.box_id)  AS box_count,
               COALESCE(SUM(b.per_box_qty), 0) AS total_qty
        FROM pm_fifo_lots fl
        JOIN pm_boxes b ON b.product_id = fl.product_id
            AND fl.lot_kind='grn' AND b.grn_id = fl.lot_ref
        WHERE fl.product_id = %s
          AND fl.lot_kind = 'grn'
          AND b.current_godown_id = %s
          AND b.current_status = 'in_stock'
    """
    params = [int(product_id), int(godown_id)]
    if fifo_start:
        sql += " AND DATE(fl.assigned_at) >= %s"
        params.append(fifo_start)
    sql += """
        GROUP BY fl.fifo_seq, fl.fifo_code, fl.lot_kind, fl.lot_ref
        HAVING box_count > 0
        ORDER BY fl.fifo_seq ASC
        LIMIT 1
    """
    oldest = conn.execute(sql, params).fetchone()

    if not oldest:
        # No in-stock boxes for this product at this godown that have FIFO
        # records — let the existing in_stock/godown check handle the case.
        return None

    oldest_seq = int(oldest['fifo_seq'])
    if scanned_seq == oldest_seq:
        return None  # FIFO OK — scanning from the oldest lot.

    # Violation. Enrich with voucher details so the user can find the
    # right boxes.
    voucher_no = ''
    supplier   = ''
    lot_date   = ''
    if oldest['lot_kind'] == 'grn':
        gv = conn.execute("""
            SELECT grn_no, supplier, grn_date FROM pm_grn WHERE id=%s LIMIT 1
        """, (oldest['lot_ref'],)).fetchone()
        if gv:
            voucher_no = gv.get('grn_no') or ''
            supplier   = gv.get('supplier') or ''
            try: lot_date = str(gv.get('grn_date') or '')[:10]
            except Exception: pass
    else:  # op
        voucher_no = f"PM-OP/{int(oldest['lot_ref']):04d}"
        # Pull movement date from the first box movement of this OP lot.
        # NOTE: column is `movement_at` (DATETIME), not `movement_date` —
        # the latter doesn't exist and was the cause of the FIFO check
        # failing on every OP-lot scan with "Unknown column 'm.movement_date'".
        opdate = conn.execute("""
            SELECT MIN(m.movement_at) AS d
            FROM pm_box_movements m
            JOIN pm_boxes b ON b.box_id = m.box_id
            WHERE b.product_id=%s AND b.grn_no=%s
        """, (int(product_id), voucher_no)).fetchone()
        if opdate and opdate.get('d'):
            try: lot_date = str(opdate['d'])[:10]
            except Exception: pass

    # ── Enrich SCANNED-lot details too ─────────────────────────────────
    # The modal previously only labelled the oldest lot with a voucher/date/
    # supplier; the scanned side just got the FIFO code. Pull the scanned
    # box's GRN row so the UI can show both sides symmetrically. Safe to do
    # unconditionally — by this point we've already ruled out OP boxes (they
    # bail at "_scanned_is_op" above), so scanned.grn_id is always a real
    # pm_grn.id for GRN-sourced scans.
    scanned_voucher  = ''
    scanned_supplier = ''
    scanned_date     = ''
    try:
        sg_id = int(scanned.get('grn_id') or 0)
    except Exception:
        sg_id = 0
    if sg_id:
        sg = conn.execute(
            "SELECT grn_no, supplier, grn_date FROM pm_grn WHERE id=%s LIMIT 1",
            (sg_id,)
        ).fetchone()
        if sg:
            scanned_voucher  = sg.get('grn_no')   or ''
            scanned_supplier = sg.get('supplier') or ''
            try: scanned_date = str(sg.get('grn_date') or '')[:10]
            except Exception: pass
    # Fallback: if for any reason the GRN row isn't there (extremely
    # unlikely — would be a broken FK) at least surface the grn_no from
    # pm_boxes so the modal isn't blank.
    if not scanned_voucher:
        scanned_voucher = str(scanned.get('grn_no') or '')

    return {
        'scanned_fifo_code': scanned.get('fifo_code') or '',
        'scanned_fifo_seq':  scanned_seq,
        # Source-voucher details for the SCANNED lot (mirrors oldest_*).
        # FIFO only fires on GRN boxes (OP boxes short-circuit at line ~2042),
        # so scanned.grn_id is always a real pm_grn.id here. Look it up so the
        # violation modal can show "you scanned from THIS GRN/date/supplier"
        # alongside the older lot the user must send first.
        'scanned_voucher':   scanned_voucher,
        'scanned_supplier':  scanned_supplier,
        'scanned_date':      scanned_date,
        'oldest_fifo_code':  oldest.get('fifo_code') or '',
        'oldest_fifo_seq':   oldest_seq,
        'oldest_lot_kind':   oldest['lot_kind'],
        'oldest_lot_ref':    int(oldest['lot_ref']),
        'oldest_voucher':    voucher_no,
        'oldest_supplier':   supplier,
        'oldest_date':       lot_date,
        'oldest_box_count':  int(oldest['box_count'] or 0),
        'oldest_total_qty':  float(oldest['total_qty'] or 0),
    }

def _next_voucher_no(conn, vtype, ref_date=None):
    """
    Generate the next voucher number using procurement_voucher_numbering format.
    Falls back to pm_voucher_sequences if no active style is configured.
    Format from numbering table: PREFIX/NNNN/SUFFIX (e.g. PM-MTV/0001/26-27)
    """
    import re as _re
    if ref_date is None:
        ref_date = date.today()
    if isinstance(ref_date, str):
        ref_date = date.fromisoformat(ref_date)

    today = str(ref_date)

    # Map internal vtype keys to procurement_voucher_numbering voucher_type values
    # Internal-only types (PM-GTXN, PM-FTXN) are intentionally omitted — those
    # are auto-created stock-ledger entries, not user-facing vouchers, and
    # are never exposed in the Voucher Numbering admin UI.
    vtype_map = {
        'PM-GRN':  'pm_grn',
        'PM-DN':   'pm_dn',
        'PM-MT':   'pm_mt',
        'PM-MTV':  'pm_mtv',
        'PM-AL':   'pm_al',
        'PM-AUD':  'pm_aud',
        'PM-OP':   'pm_op',
        'PM-MR':   'pm_mr',
        'PM-PO':   'pm_po',
        'PM-ADJ':  'pm_adj',
        'PM-TRS':  'pm_trs',
    }
    pvn_type = vtype_map.get(vtype)

    if pvn_type:
        try:
            vn = conn.execute(
                """SELECT prefix, suffix, digits, start_num
                   FROM procurement_voucher_numbering
                   WHERE voucher_type=%s AND valid_from<=%s AND valid_to>=%s
                   ORDER BY id DESC LIMIT 1""",
                (pvn_type, today, today)
            ).fetchone()

            if vn:
                prefix  = (vn['prefix'] or '').strip()
                suffix  = (vn['suffix'] or '').strip()
                digits  = int(vn['digits'] or 4)
                start   = int(vn['start_num'] or 1)

                # Find max sequence from existing vouchers.
                # tbl_map: pvn_type → (table_name, voucher_number_column)
                # When new types are added here, the vtype_map above must
                # already route the internal vtype to the matching pvn_type.
                tbl_map = {
                    'pm_grn': ('pm_grn',       'grn_no'),
                    'pm_dn':  ('pm_dn',        'dn_no'),
                    'pm_mt':  ('pm_transfers', 'transfer_no'),
                    'pm_mtv': ('pm_mtv',       'mtv_no'),
                    # AL/AUD/OP entries are kept here for when their route
                    # files start calling _next_voucher_no. Until then their
                    # vtypes aren't passed in, so these rows just sit dormant.
                    # Allotments are stored in pm_transfers with voucher_type='allotment'
                    # (NOT in a separate pm_allotment table — that table does not exist).
                    'pm_al':  ('pm_transfers',     'transfer_no'),
                    'pm_aud': ('pm_audit_sessions','session_no'),
                    'pm_op':  ('pm_opening_stock', 'op_no'),
                    'pm_mr':  ('pm_material_requests', 'request_no'),
                    'pm_po':  ('pm_purchase_orders',   'po_num'),
                    'pm_adj': ('pm_stock_adjustments', 'adj_no'),
                    'pm_trs': ('pm_grn_trs',          'trs_num'),
                }
                tbl, col = tbl_map.get(pvn_type, ('pm_grn','grn_no'))
                pattern  = (prefix + '/%') if prefix else '%'
                rows = conn.execute(
                    f"SELECT {col} FROM {tbl} WHERE {col} LIKE %s FOR UPDATE", (pattern,)
                ).fetchall()
                max_seq = start - 1
                for row in rows:
                    nums = _re.findall(r'(\d{' + str(digits) + r',})', str(row[col] or ''))
                    if nums:
                        max_seq = max(max_seq, int(nums[-1]))
                next_seq = max_seq + 1
                return '/'.join(p for p in [prefix, str(next_seq).zfill(digits), suffix] if p)
        except Exception:
            pass  # Fall through to legacy system

    # ── Legacy fallback: pm_voucher_sequences ────────────────────────────────
    cur_year  = ref_date.year
    fy_start  = cur_year if ref_date.month >= 4 else cur_year - 1
    fy_label  = f"{str(fy_start)[2:]}-{str(fy_start+1)[2:]}"

    row = conn.execute(
        "SELECT * FROM pm_voucher_sequences WHERE voucher_type=%s FOR UPDATE", (vtype,)
    ).fetchone()

    if not row:
        # ── Last-resort fallback: read max from the actual transfer table.
        # Avoids duplicate-key crashes when the sequences row was never seeded
        # (or was seeded under a different voucher_type key — e.g. 'allotment'
        #  instead of 'PM-AL', which is exactly the situation that caused the
        #  'Duplicate entry PM-AL-0001' crash on a fresh Allotment voucher).
        if vtype in ('PM-MT', 'PM-AL'):
            try:
                # Scan ALL existing transfer_no values that start with this
                # prefix, regardless of separator format ("PM-AL/26-27/0001",
                # "PM-AL-0001", legacy "PM-AL0001", etc.). Take the max of
                # every trailing number we can extract and add 1. This makes
                # the function safe against mixed-format historical data.
                rows = conn.execute(
                    "SELECT transfer_no FROM pm_transfers "
                    "WHERE transfer_no LIKE %s FOR UPDATE",
                    (f'{vtype}%',)
                ).fetchall()
                max_seq = 0
                for r in rows:
                    tno = (r['transfer_no'] or '')
                    nums = _re.findall(r'(\d+)', tno)
                    if nums:
                        try:
                            n = int(nums[-1])
                            if n > max_seq:
                                max_seq = n
                        except ValueError:
                            pass
                nxt = max_seq + 1
                return f"{vtype}/{fy_label}/{str(nxt).zfill(4)}"
            except Exception:
                pass
        # PM-PO has its own table (pm_purchase_orders.po_num) — handle it
        # the same way: scan existing po_nums, take max + 1. Lets the first
        # PO be created without requiring the admin to pre-configure a
        # procurement_voucher_numbering row.
        if vtype == 'PM-PO':
            try:
                rows = conn.execute(
                    "SELECT po_num FROM pm_purchase_orders "
                    "WHERE po_num LIKE %s FOR UPDATE",
                    (f'{vtype}%',)
                ).fetchall()
                max_seq = 0
                for r in rows:
                    pno = (r['po_num'] or '')
                    nums = _re.findall(r'(\d+)', pno)
                    if nums:
                        try:
                            n = int(nums[-1])
                            if n > max_seq:
                                max_seq = n
                        except ValueError:
                            pass
                nxt = max_seq + 1
                return f"{vtype}/{fy_label}/{str(nxt).zfill(4)}"
            except Exception:
                pass
        # PM-ADJ stock-adjustment vouchers — same pattern as PM-PO. Lets the
        # first adjustment be created without admin pre-configuring a
        # procurement_voucher_numbering row.
        if vtype == 'PM-ADJ':
            try:
                rows = conn.execute(
                    "SELECT adj_no FROM pm_stock_adjustments "
                    "WHERE adj_no LIKE %s FOR UPDATE",
                    (f'{vtype}%',)
                ).fetchall()
                max_seq = 0
                for r in rows:
                    ano = (r['adj_no'] or '')
                    nums = _re.findall(r'(\d+)', ano)
                    if nums:
                        try:
                            n = int(nums[-1])
                            if n > max_seq:
                                max_seq = n
                        except ValueError:
                            pass
                nxt = max_seq + 1
                return f"{vtype}/{fy_label}/{str(nxt).zfill(4)}"
            except Exception:
                pass
        # PM-TRS testing requisition slips — same fallback pattern.
        # Note: the on-screen TRS number in the printed slip is the same
        # value as trs_num.  Admins who want a different display format
        # (e.g. the RM convention "0001/26-27/PM") can configure a
        # procurement_voucher_numbering row to override this default.
        if vtype == 'PM-TRS':
            try:
                rows = conn.execute(
                    "SELECT trs_num FROM pm_grn_trs "
                    "WHERE trs_num LIKE %s FOR UPDATE",
                    (f'{vtype}%',)
                ).fetchall()
                max_seq = 0
                for r in rows:
                    tno = (r['trs_num'] or '')
                    nums = _re.findall(r'(\d+)', tno)
                    if nums:
                        try:
                            n = int(nums[-1])
                            if n > max_seq:
                                max_seq = n
                        except ValueError:
                            pass
                nxt = max_seq + 1
                return f"{vtype}/{fy_label}/{str(nxt).zfill(4)}"
            except Exception:
                pass
        # Truly nothing we can do — return the dash-form, but bump the suffix
        # past anything already present so we don't crash on the UNIQUE key.
        try:
            rows = conn.execute(
                "SELECT transfer_no FROM pm_transfers WHERE transfer_no LIKE %s",
                (f'{vtype}%',)
            ).fetchall()
            max_seq = 0
            for r in rows:
                nums = _re.findall(r'(\d+)', r['transfer_no'] or '')
                if nums:
                    try:
                        n = int(nums[-1])
                        if n > max_seq:
                            max_seq = n
                    except ValueError:
                        pass
            return f"{vtype}-{str(max_seq + 1).zfill(4)}"
        except Exception:
            return f"{vtype}-0001"

    last_num     = int(row['last_num'])
    last_year    = int(row['last_year'] or 0)
    pad          = int(row['pad_digits'] or 4)
    prefix       = row['prefix'] or vtype
    reset_yearly = bool(row['reset_yearly'])

    if reset_yearly and last_year != fy_start:
        last_num = 0

    last_num += 1
    conn.execute(
        "UPDATE pm_voucher_sequences SET last_num=%s, last_year=%s WHERE voucher_type=%s",
        (last_num, fy_start if reset_yearly else 0, vtype)
    )

    num_str = str(last_num).zfill(pad)
    if reset_yearly:
        return f"{prefix}/{fy_label}/{num_str}"
    else:
        return f"{prefix}/{num_str}"

def _clean_for_code(text, max_len):
    """Strip to alphanumeric uppercase, take up to max_len chars."""
    import re as _re
    cleaned = _re.sub(r'[^A-Za-z0-9]', '', str(text or '')).upper()
    return cleaned[:max_len]

def _normalize_product_name(name):
    """Canonical form of a product name for DUPLICATE DETECTION only.

    Visual duplicates (same product typed slightly differently) should be
    treated as the same product. We normalize by: trimming, collapsing any
    run of whitespace to a single space, and lower-casing. We do NOT change
    the stored name — this is purely the key used to compare names.

    'CM - Plix (Fruits  + Actives ) Pack Of 4 Box'  and
    'CM - Plix (Fruits + Actives ) Pack of 4 Box'   →  same key.
    """
    import re as _re
    s = str(name or '').strip()
    s = _re.sub(r'\s+', ' ', s)      # collapse internal whitespace runs
    return s.lower()


def _find_duplicate_product(conn, name, pm_type, exclude_id=None):
    """Return an existing product row that is a duplicate of (name, pm_type)
    under the normalized comparison, or None. Matches the SAME pm_type only
    (a Box and a Tube may share a name by design). Whitespace/case-insensitive.
    """
    key = _normalize_product_name(name)
    rows = conn.execute(
        "SELECT id, product_name, product_code, brand_id, pm_type FROM pm_products WHERE pm_type=%s",
        (pm_type,)
    ).fetchall()
    for r in rows:
        if r['id'] == exclude_id:
            continue
        if _normalize_product_name(r['product_name']) == key:
            return r
    return None


def _generate_product_code(conn, brand_name, pm_type, exclude_id=None):
    """
    Generate a unique 10-character alphanumeric product code:
      [up to 4 chars from brand] + [up to 4 chars from PM type] + random digits
      (filling remaining positions to reach exactly 10 chars)
    Retries with new random suffix on collision (up to 50 attempts).
    """
    import random
    brand_part = _clean_for_code(brand_name, 4)
    pm_part    = _clean_for_code(pm_type,    4)
    if not brand_part or not pm_part:
        raise ValueError("Brand and PM type must contain at least one alphanumeric character")

    fixed       = brand_part + pm_part            # 2..8 chars
    rand_digits = 10 - len(fixed)                 # 2..8 digits
    if rand_digits < 1:
        # Should never happen since brand_part<=4 and pm_part<=4 → fixed<=8
        rand_digits = 1
        fixed = fixed[:9]

    for _ in range(50):
        suffix = ''.join(random.choices('0123456789', k=rand_digits))
        candidate = (fixed + suffix)[:10]
        # Check uniqueness in DB (excluding the row being updated, if any)
        if exclude_id:
            row = conn.execute(
                "SELECT id FROM pm_products WHERE product_code=%s AND id<>%s LIMIT 1",
                (candidate, exclude_id)
            ).fetchone()
        else:
            row = conn.execute(
                "SELECT id FROM pm_products WHERE product_code=%s LIMIT 1", (candidate,)
            ).fetchone()
        if not row:
            return candidate

    # Extreme fallback: shouldn't be reachable — try mixed alphanumeric
    import string
    alphabet = string.ascii_uppercase + string.digits
    for _ in range(50):
        candidate = (fixed + ''.join(random.choices(alphabet, k=rand_digits)))[:10]
        row = conn.execute(
            "SELECT id FROM pm_products WHERE product_code=%s LIMIT 1", (candidate,)
        ).fetchone()
        if not row:
            return candidate

    raise RuntimeError("Could not generate a unique product code after 100 attempts")

def _brand_name_by_id(conn, brand_id):
    if not brand_id:
        return ''
    row = conn.execute(
        "SELECT name FROM procurement_brands WHERE id=%s", (int(brand_id),)
    ).fetchone()
    return (row['name'] if row else '') or ''

def _grn_seq_part(grn_no):
    """
    Extract the 4-digit sequence from a GRN voucher number.
    'PM-GRN/0234/26-27' → 'G0234'. Falls back to 'G0000' if pattern doesn't match.
    """
    import re as _re
    m = _re.search(r'/(\d{1,5})/', str(grn_no or ''))
    if m:
        return 'G' + m.group(1).zfill(4)
    # Fallback: take any digit run
    m = _re.search(r'(\d+)', str(grn_no or ''))
    return ('G' + m.group(1).zfill(4)) if m else 'G0000'

def _make_box_code(product_code, grn_no, box_seq):
    """
    Build a box code: PRODUCTCODE-GNNNN-BNNN
    Example: BEARTUBE12-G0234-B003
    box_seq is 1-based.
    """
    pc = (product_code or '').upper().strip() or 'XXXXXXXXXX'
    g  = _grn_seq_part(grn_no)
    bs = 'B' + str(int(box_seq or 0)).zfill(3)
    return f"{pc}-{g}-{bs}"


# ──────────────────────────────────────────────────────────────────────────
# Short-code helpers (8-char sequential QR payload)
# ──────────────────────────────────────────────────────────────────────────
#
# Format: 1 letter + 7 digits → A0000001 .. A9999999, then B0000001 ..
# Z9999999, then AA0000001 onwards. Total runs:
#   * 1-letter prefix: 26 × 9,999,999 ≈ 260M codes (A0000001 .. Z9999999)
#   * 2-letter prefix: 676 × 9,999,999 ≈ 6.76B codes (AA0000001 .. ZZ9999999)
#   * 3-letter prefix: ~175B codes
#
# Coexistence with legacy long box_codes: scan endpoints accept either form
# (`WHERE b.short_code=%s OR b.box_code=%s`). Old labels keep scanning;
# new labels carry the compact short_code in their QR.
#
# Uniqueness guarantee (three independent layers, defence in depth):
#   Layer 1 — DB unique index on pm_boxes.short_code. Final arbiter.
#   Layer 2 — Pre-check SELECT against existing short_code before UPDATE.
#   Layer 3 — Conditional WHERE on UPDATE (short_code IS NULL OR =''),
#             so a concurrent assigner cannot overwrite a code another
#             worker has already written.
#
# Concurrency: in the rare race where two workers compute the same MAX+1
# in the same instant, the second worker's UPDATE trips the unique index;
# the retry loop then recomputes MAX and grabs the next slot. Bounded by
# max_attempts to prevent pathological pinning.

def _short_seq_to_code(seq):
    """Convert a 1-based monotonic sequence to A0000001..A9999999, B0000001..
    Z9999999, AA0000001..ZZ9999999, AAA0000001..., etc.

    Each letter slot holds 9,999,999 codes (0000001-9999999). The seq →
    (letters, num) mapping uses divmod by 9,999,999 to advance through
    letter slots.
    """
    if seq is None or seq < 1:
        return ''
    n = int(seq) - 1
    SLOT_SIZE = 9_999_999
    letter_slot, num_in_slot = divmod(n, SLOT_SIZE)
    # Convert letter_slot (0,1,2,...) to base-26 letters: 0='A', 1='B', ...,
    # 25='Z', 26='AA', 27='AB', ..., 701='ZZ', 702='AAA', and so on.
    letters = ''
    s = letter_slot
    while True:
        letters = chr(ord('A') + (s % 26)) + letters
        s = s // 26 - 1
        if s < 0:
            break
    return f"{letters}{num_in_slot + 1:07d}"


def _code_to_short_seq(code):
    """Inverse of _short_seq_to_code. Returns 1-based seq, or 0 if `code`
    isn't a valid sequential short_code in our format.

    Pattern: one or more uppercase letters followed by exactly 7 digits.
    """
    import re
    if not code:
        return 0
    m = re.match(r'^([A-Z]+)(\d{7})$', code.strip().upper())
    if not m:
        return 0
    letters, digits = m.group(1), m.group(2)
    # Letters → base-26 slot. 'A'=0, 'B'=1, ..., 'Z'=25, 'AA'=26, ...
    letter_slot = 0
    for ch in letters:
        letter_slot = letter_slot * 26 + (ord(ch) - ord('A') + 1)
    letter_slot -= 1  # un-shift so 'A' becomes 0
    num_in_slot = int(digits) - 1
    SLOT_SIZE = 9_999_999
    if num_in_slot < 0 or num_in_slot > SLOT_SIZE - 1:
        return 0
    return letter_slot * SLOT_SIZE + num_in_slot + 1


def _next_short_code_seq(conn):
    """Compute the next sequential slot for a short_code assignment.

    Strategy: read MAX seq from existing pm_boxes.short_code values that
    match the sequential pattern, then return max+1. Anything that doesn't
    match `^[A-Z]+[0-9]{7}$` is ignored (filters out legacy random codes
    if any, plus malformed entries).

    Returns 1 if no sequential codes exist yet.

    Performance note: this is called once per box-creation, so we MUST
    avoid Python-side loops over all rows. We push the MAX computation
    into MySQL using SUBSTRING + CAST so the DB does the heavy lifting
    and returns a single number. The unique index on short_code makes
    this fast even with millions of rows.
    """
    # Restrict to single-letter-prefix codes for the simple, fast case.
    # Once anyone overflows past Z9999999 we'll cross the multi-letter
    # bridge — for the foreseeable future (260M codes per letter run × 26
    # letters = 6.76B before we'd need a 2-letter prefix), this is a no-op.
    row = conn.execute(
        """SELECT MAX(
                 (ASCII(LEFT(short_code, 1)) - ASCII('A')) * 9999999
                 + CAST(SUBSTRING(short_code, 2) AS UNSIGNED)
               ) AS max_seq
           FROM pm_boxes
           WHERE short_code IS NOT NULL
             AND CHAR_LENGTH(short_code) = 8
             AND short_code REGEXP '^[A-Z][0-9]{7}$'"""
    ).fetchone()
    max_seq = int((row.get('max_seq') if row else 0) or 0)
    return max_seq + 1


def _reissue_box_short_code(conn, box_id, max_attempts=12):
    """Force-assign a BRAND-NEW sequential short_code to a box, replacing
    any existing one. Used by the "reissue replacement label" flow when a
    printed QR is damaged/unscannable: the operator gets a fresh label whose
    QR encodes a new, shorter code. The old short_code is freed (set NULL)
    so the new one is the only identifier in circulation for that box.

    Returns (new_code, old_code). Raises RuntimeError if it can't land a
    fresh code within max_attempts (practically unreachable).

    Caller manages the transaction (no commit here).
    """
    row = conn.execute(
        "SELECT short_code FROM pm_boxes WHERE box_id=%s LIMIT 1",
        (box_id,)
    ).fetchone()
    if not row:
        raise RuntimeError(f'box_id={box_id} not found')
    old_code = (row.get('short_code') or '').strip() or None

    # Free the old code first so _next_short_code_seq advances past the
    # current max and the box can be re-stamped without colliding with itself.
    conn.execute("UPDATE pm_boxes SET short_code=NULL WHERE box_id=%s", (box_id,))

    last_error = None
    for _ in range(max_attempts):
        try:
            code = _gen_short_code(conn)
            if not code:
                last_error = RuntimeError('next-seq returned empty'); continue
            taken = conn.execute(
                "SELECT 1 FROM pm_boxes WHERE short_code=%s LIMIT 1", (code,)
            ).fetchone()
            if taken:
                continue
            conn.execute(
                "UPDATE pm_boxes SET short_code=%s "
                "WHERE box_id=%s AND (short_code IS NULL OR short_code='')",
                (code, box_id)
            )
            check = conn.execute(
                "SELECT short_code FROM pm_boxes WHERE box_id=%s LIMIT 1", (box_id,)
            ).fetchone()
            landed = (check.get('short_code') or '').strip() if check else ''
            if landed:
                return landed, old_code
        except Exception as e:
            last_error = e
            continue
    import sys as _sys
    msg = (f"[pm_stock] _reissue_box_short_code: exhausted {max_attempts} "
           f"attempts for box_id={box_id}"
           + (f" — last error: {last_error}" if last_error else ""))
    print(msg, file=_sys.stderr)
    raise RuntimeError(msg)


def _assemble_box_label(conn, box_id):
    """Build the single-label payload dict the client renderer needs for one
    box. Read-only — does NOT reissue or mutate. Works for both GRN boxes
    and OP (opening-stock) boxes. Returns None if the box isn't found.

    The `new_short_code` field is set to the box's CURRENT short_code; the
    reissue endpoints overwrite it with the freshly-assigned code when they
    print a replacement.
    """
    box = conn.execute("""
        SELECT b.box_id, b.box_code, b.short_code, b.grn_id, b.grn_no,
               b.product_id, b.product_code, b.box_seq, b.total_boxes,
               b.per_box_qty, b.current_status, b.current_godown_id,
               p.product_name, p.pm_type,
               COALESCE(b.product_version,'') AS product_version,
               COALESCE(br.name,'')           AS brand_name,
               COALESCE(cg.name,'')           AS current_godown_name
        FROM pm_boxes b
        JOIN pm_products p ON p.id = b.product_id
        LEFT JOIN procurement_brands br ON br.id = p.brand_id
        LEFT JOIN procurement_godowns cg ON cg.id = b.current_godown_id
        WHERE b.box_id=%s LIMIT 1
    """, (box_id,)).fetchone()
    if not box:
        return None

    is_op = (not box['grn_id']) or str(box['grn_no'] or '').upper().startswith('PM-OP/')

    grn = None
    if not is_op and box['grn_id']:
        grn = conn.execute("""
            SELECT g.grn_no, g.grn_date, g.supplier,
                   COALESCE(g.party_invoice_no,'')  AS party_invoice_no,
                   g.party_invoice_date, COALESCE(g.created_by,'') AS created_by,
                   COALESCE(gd.name,'') AS godown_name
            FROM pm_grn g
            LEFT JOIN procurement_godowns gd ON gd.id = g.godown_id
            WHERE g.id=%s LIMIT 1
        """, (box['grn_id'],)).fetchone()

    fifo_code = ''
    try:
        if is_op:
            op_ref = 0
            try:
                op_ref = int(str(box['grn_no']).split('/')[-1])
            except Exception:
                op_ref = 0
            if op_ref:
                fi = _get_or_assign_fifo(conn, 'op', op_ref, box['product_id'])
                fifo_code = fi.get('fifo_code', '') or ''
        elif box['grn_id']:
            fi = _get_or_assign_fifo(conn, 'grn', box['grn_id'], box['product_id'])
            fifo_code = fi.get('fifo_code', '') or ''
    except Exception:
        fifo_code = ''

    def _fmt(dt):
        if not dt: return ''
        s = str(dt)[:10]
        p = s.split('-')
        return f"{p[2]}/{p[1]}/{p[0]}" if len(p) == 3 else s

    per_box = float(box['per_box_qty'] or 0)
    label = {
        'isOpening':       bool(is_op),
        'box_id':          box['box_id'],
        'product_id':      box['product_id'],
        'product_code':    box['product_code'] or '',
        'product_name':    box['product_name'] or '',
        'product_version': box['product_version'] or '',
        'pm_type':         box['pm_type'] or '',
        'brand_name':      box['brand_name'] or '',
        'box_code':        box['box_code'],
        'new_short_code':  (box['short_code'] or box['box_code']),
        'box_seq':         int(box['box_seq'] or 1),
        'total_boxes':     int(box['total_boxes'] or 1),
        'per_box_qty':     per_box,
        'fifo_code':       fifo_code,
        'supervisor':      (grn['created_by'] if grn else None) or '',
    }
    if is_op:
        label.update({
            'op_label':         box['grn_no'] or '',
            'op_date_fmt':      '',
            'location_name':    box['current_godown_name'] or '',
            'supplier_text':    'Opening Stock',
            'grn_no':           box['grn_no'] or '',
            'grn_date_fmt':     '',
            'invoice_no':       '—',
            'invoice_date_fmt': '—',
        })
    else:
        label.update({
            'supplier_text':    (grn['supplier'] if grn else '') or '',
            'grn_no':           (grn['grn_no'] if grn else box['grn_no']) or '',
            'grn_date_fmt':     _fmt(grn['grn_date']) if grn else '',
            'invoice_no':       (grn['party_invoice_no'] if grn else '') or '—',
            'invoice_date_fmt': _fmt(grn['party_invoice_date']) if grn else '—',
            'location_name':    (grn['godown_name'] if grn else '') or '',
        })
    return label


def _gen_short_code(conn):
    """Return the next unused sequential short code (e.g. 'A0000001').

    Uniqueness is enforced by the three layers above — if two workers
    race for the same seq, the second one's UPDATE trips the unique
    index and _assign_box_short_code retries with the next slot.
    """
    return _short_seq_to_code(_next_short_code_seq(conn))


def _assign_box_short_code(conn, box_id, max_attempts=12):
    """Assign a fresh sequential short_code to pm_boxes row box_id, if it
    doesn't already have one.

    Idempotent — if the box already has a non-empty short_code, returns it
    unchanged. Safe to call from healer/migration paths that re-run on rows
    that may or may not already be coded.

    Returns the short_code on success.

    Raises RuntimeError if every attempt within max_attempts somehow
    collided — practically unreachable with sequential generation outside
    of pathological concurrent assignment, but failing loudly beats
    silently stamping NULL on the row.
    """
    try:
        row = conn.execute(
            "SELECT short_code FROM pm_boxes WHERE box_id=%s LIMIT 1",
            (box_id,)
        ).fetchone()
    except Exception:
        return None
    if not row:
        return None
    existing = (row.get('short_code') or '').strip()
    if existing:
        return existing

    last_error = None
    for _ in range(max_attempts):
        try:
            # Recompute next seq on every attempt — a collision naturally
            # advances to the next free slot rather than retrying the same
            # value forever.
            code = _gen_short_code(conn)
            if not code:
                last_error = RuntimeError('next-seq returned empty')
                continue

            # Layer 2: collision pre-check (race-defence).
            taken = conn.execute(
                "SELECT 1 FROM pm_boxes WHERE short_code=%s LIMIT 1",
                (code,)
            ).fetchone()
            if taken:
                continue

            # Layer 3: race-safe UPDATE — only writes if the row is still
            # unclaimed. Empty string treated as "unclaimed" too.
            conn.execute(
                "UPDATE pm_boxes SET short_code=%s "
                "WHERE box_id=%s AND (short_code IS NULL OR short_code='')",
                (code, box_id)
            )

            # Confirm what actually landed. If a concurrent assigner beat
            # us, return THEIR code (the row is assigned, uniqueness still
            # holds across the DB).
            check = conn.execute(
                "SELECT short_code FROM pm_boxes WHERE box_id=%s LIMIT 1",
                (box_id,)
            ).fetchone()
            landed = (check.get('short_code') or '').strip() if check else ''
            if landed:
                return landed
        except Exception as e:
            last_error = e
            continue

    import sys as _sys
    msg = (f"[pm_stock] _assign_box_short_code: exhausted {max_attempts} "
           f"attempts for box_id={box_id}"
           + (f" — last error: {last_error}" if last_error else ""))
    print(msg, file=_sys.stderr)
    raise RuntimeError(msg)


def _find_box_by_any_code(conn, code, extra_cols=''):
    """Look up a pm_boxes row by either short_code or box_code.

    Newly-printed labels carry short_code in their QR; old labels still in
    circulation carry the long box_code. Both must route to the same box
    record — scan endpoints can call this helper rather than hard-coding
    `WHERE box_code=%s`.

    `extra_cols`: comma-prefixed string of additional projections (e.g.
    ", b.parent_box_id"). Returns the row dict or None.
    """
    code = (code or '').strip()
    if not code:
        return None
    return conn.execute(
        f"""SELECT b.box_id, b.box_code, b.short_code, b.product_id, b.product_code,
                   b.per_box_qty, b.current_godown_id, b.current_status,
                   p.product_name, p.pm_type
                   {extra_cols}
            FROM pm_boxes b
            JOIN pm_products p ON p.id = b.product_id
            WHERE b.short_code = %s OR b.box_code = %s
            LIMIT 1""",
        (code.upper(), code.upper())
    ).fetchone()


def _make_group_code(product_code, grn_no, group_seq):
    """
    Build a group/bag code: BAG-PRODUCTCODE-GNNNN-LNNN
    Example: BAG-BEARTUBE12-G0234-L001

    The leading BAG- prefix lets the global QR pipeline route group scans
    to the group endpoint instead of the box endpoint, with no manual
    mode switch needed. The suffix uses 'L' for "lot" instead of the box
    code's 'B', so a glance at the printed sticker tells the operator
    "this is a lot label, not a box label."

    group_seq is 1-based, scoped to (product_id, grn_id) — multiple groups
    on the same GRN line get L001, L002, etc.
    """
    pc = (product_code or '').upper().strip() or 'XXXXXXXXXX'
    g  = _grn_seq_part(grn_no)
    ls = 'L' + str(int(group_seq or 0)).zfill(3)
    return f"BAG-{pc}-{g}-{ls}"


def _heal_box_location(conn, box_id, expected_godown_id, current_godown_id, user=None):
    """Self-healing location reconciler.

    Called from scan endpoints when a box's pm_boxes.current_godown_id
    doesn't match the godown the operator is scanning at. Looks at the
    box's last movement to decide whether the mismatch is genuine
    (caller should still error) or a stale row that can be healed.

    Returns one of:
        ('heal',  reason_string) — DB row was updated to expected_godown_id;
                                   the scan should proceed.
        ('error', reason_string) — genuine location mismatch; caller should
                                   keep its existing error path.

    Heal-criteria: the most recent pm_box_movements row for this box must
    have `to_godown_id` equal to the godown the operator is currently
    scanning at. That row is the most authoritative answer to "where did
    this box go last" — if it says GODOWN X and the operator is at
    GODOWN X, the pm_boxes.current_godown_id field is simply stale and
    we can safely heal it. If the last movement says somewhere else,
    the box really is mis-located in the database AND/OR the operator
    is at the wrong physical place — either way, fail loud.

    On heal: records a 'location_heal' pm_box_movements row so the
    audit trail captures the correction. The row has from_godown_id =
    the stale value we just overwrote, to_godown_id = the expected
    value, and remarks tagged with the source so it's traceable.

    This intentionally does NOT auto-heal when there are zero recorded
    movements (a box freshly inserted by an old bug, no audit trail) —
    in that case we can't tell where it should be, so we don't guess.
    """
    # Look up the most recent movement that actually changed location
    # (skip 'grn_create' which is the initial setup, since by definition
    # it matches the stale pm_boxes row we'd be checking against).
    # Order by movement_id DESC because it's monotonic per box and
    # cheaper than ordering by created_at.
    last_mv = conn.execute(
        """SELECT movement_id, movement_type, from_godown_id, to_godown_id, created_at
             FROM pm_box_movements
            WHERE box_id = %s
              AND movement_type IN ('out', 'in', 'transfer_in', 'transfer_out',
                                    'adjust', 'manual_relocate', 'location_heal',
                                    'grn_create')
            ORDER BY movement_id DESC
            LIMIT 1""",
        (box_id,)
    ).fetchone()
    if not last_mv:
        # No movements recorded for this box. Can't be sure where it
        # should be — refuse to guess, keep the error.
        return ('error', 'no_movement_history')

    mv_to = last_mv['to_godown_id'] if hasattr(last_mv, 'get') else last_mv[3]
    if int(mv_to or 0) != int(expected_godown_id):
        # The ledger agrees the box is NOT at the scan-source godown.
        # Genuine mismatch. Keep the error.
        return ('error', f'last_move_to={mv_to}')

    # Ledger says the box IS at the scan-source godown but the cached
    # current_godown_id on pm_boxes is wrong. Heal it.
    conn.execute(
        "UPDATE pm_boxes SET current_godown_id=%s WHERE box_id=%s",
        (expected_godown_id, box_id)
    )
    try:
        conn.execute(
            """INSERT INTO pm_box_movements
                 (box_id, transfer_id, movement_type, from_godown_id, to_godown_id, qty, moved_by, remarks)
               VALUES (%s, NULL, 'location_heal', %s, %s, 0, %s, %s)""",
            (box_id, current_godown_id, expected_godown_id, user or _user(),
             'Auto-heal: pm_boxes.current_godown_id was stale; corrected from ledger')
        )
    except Exception:
        # Don't let an audit-insert failure block the heal — the heal
        # itself already happened. Best-effort logging only.
        pass
    return ('heal', 'ledger_match')


def _make_group_code_legacy_alias(*a, **k):
    return _make_group_code(*a, **k)


def _next_group_seq(conn, product_id, grn_id):
    """
    Find the next free L-suffix for a (product, grn) pair.
    Walks pm_box_groups and returns max(seq)+1.
    """
    if not grn_id:
        # Standalone group (Phase 2). For now, fall back to a global
        # MAX(group_id)+1 — the L-suffix is local to the GRN context.
        return 1
    rows = conn.execute(
        """SELECT group_code FROM pm_box_groups
           WHERE product_id=%s AND grn_id=%s""",
        (product_id, grn_id)
    ).fetchall()
    max_seq = 0
    for r in rows:
        # Parse trailing L\d+ from the code
        code = r['group_code'] or ''
        m = code.rsplit('-L', 1)
        if len(m) == 2:
            try: max_seq = max(max_seq, int(m[1]))
            except Exception: pass
    return max_seq + 1


def _refresh_group_status(conn, group_id):
    """
    Recompute member_count, total_qty, current_godown_id, current_status
    for a group based on its members. Call this after any operation that
    changes member statuses or memberships.

    Status logic (priority order):
      • All members consumed/lost  → 'consumed'
      • Any member in_transit       → 'in_transit'
      • Members at different godowns OR mixed statuses → 'partial'
      • All members in_stock at same godown → 'in_stock'
      • Empty group (no members)    → 'superseded'
    """
    if not group_id: return
    members = conn.execute(
        """SELECT b.box_id, b.current_status, b.current_godown_id,
                  b.per_box_qty
           FROM pm_box_group_members m
           JOIN pm_boxes b ON b.box_id = m.box_id
           WHERE m.group_id = %s""",
        (group_id,)
    ).fetchall()
    if not members:
        # Group has no members left — mark superseded
        conn.execute(
            """UPDATE pm_box_groups
               SET member_count=0, total_qty=0, current_status='superseded'
               WHERE group_id=%s""",
            (group_id,)
        )
        return

    statuses = {m['current_status'] for m in members}
    godowns  = {m['current_godown_id'] for m in members if m['current_godown_id']}
    total_qty = sum(float(m['per_box_qty'] or 0) for m in members)
    member_count = len(members)

    # Decide unified status
    if statuses <= {'consumed', 'lost', 'damaged'}:
        new_status = 'consumed'
    elif 'in_transit' in statuses and len(statuses) == 1 and len(godowns) <= 1:
        new_status = 'in_transit'
    elif statuses == {'in_stock'} and len(godowns) <= 1:
        new_status = 'in_stock'
    else:
        # Mixed — some in_stock, some in_transit, or different godowns
        new_status = 'partial'

    # Pick a representative godown — if all members agree, use that;
    # else keep whatever was there (god knows what the user wants for
    # a partial group).
    new_godown = list(godowns)[0] if len(godowns) == 1 else None
    if new_godown is not None:
        conn.execute(
            """UPDATE pm_box_groups
               SET member_count=%s, total_qty=%s,
                   current_godown_id=%s, current_status=%s
               WHERE group_id=%s""",
            (member_count, total_qty, new_godown, new_status, group_id)
        )
    else:
        conn.execute(
            """UPDATE pm_box_groups
               SET member_count=%s, total_qty=%s, current_status=%s
               WHERE group_id=%s""",
            (member_count, total_qty, new_status, group_id)
        )


def _create_group_for_boxes(conn, product_id, grn_id, grn_no, godown_id,
                             box_ids, label=None, remarks=None, user=None):
    """
    Bundle a list of pm_boxes rows into a new pm_box_groups entry.

    Validates:
      • All boxes exist and share the same product_id (matches the passed in)
      • No box is already in another group
      • At least 2 boxes (a "group of 1" is meaningless)

    Returns the new group dict {group_id, group_code, ...} on success.
    Raises ValueError on validation failure (caller catches and returns 400).
    """
    if not box_ids or len(box_ids) < 2:
        raise ValueError('A group needs at least 2 boxes')
    placeholders = ','.join(['%s'] * len(box_ids))
    rows = conn.execute(
        f"""SELECT box_id, product_id, current_godown_id, current_status,
                   per_box_qty, group_id, grn_id
           FROM pm_boxes
           WHERE box_id IN ({placeholders})""",
        tuple(box_ids)
    ).fetchall()
    if len(rows) != len(box_ids):
        found = {r['box_id'] for r in rows}
        missing = [b for b in box_ids if b not in found]
        raise ValueError(f'Boxes not found: {missing}')
    # Validate uniformity
    for r in rows:
        if r['product_id'] != product_id:
            raise ValueError(
                f"Box {r['box_id']} has a different product than the group "
                f"target. All boxes in a group must share the same product.")
        if r['current_status'] != 'in_stock':
            raise ValueError(
                f"Box {r['box_id']} is not in_stock (status={r['current_status']}); "
                f"cannot add to a new group.")
        if r['current_godown_id'] != godown_id:
            raise ValueError(
                f"Box {r['box_id']} is at a different godown than the group "
                f"target. All boxes in a group must be at the same godown.")
        if r['group_id']:
            raise ValueError(
                f"Box {r['box_id']} is already in group #{r['group_id']}; "
                f"remove it from that group first.")

    # All checks passed. Allocate the group code + insert.
    seq = _next_group_seq(conn, product_id, grn_id)
    # Look up product_code for the code-generator
    p = conn.execute(
        "SELECT product_code FROM pm_products WHERE id=%s", (product_id,)
    ).fetchone()
    product_code = (p['product_code'] if p else '') or 'XXXXXXXXXX'
    group_code = _make_group_code(product_code, grn_no or '', seq)

    member_count = len(rows)
    total_qty = sum(float(r['per_box_qty'] or 0) for r in rows)

    conn.execute(
        """INSERT INTO pm_box_groups
             (group_code, group_label, product_id, grn_id, grn_no,
              current_godown_id, current_status, member_count, total_qty,
              created_by, remarks)
           VALUES (%s,%s,%s,%s,%s,%s,'in_stock',%s,%s,%s,%s)""",
        (group_code, label, product_id, grn_id, grn_no,
         godown_id, member_count, total_qty, user, remarks)
    )
    new_group_id = conn.execute(
        "SELECT group_id FROM pm_box_groups WHERE group_code=%s", (group_code,)
    ).fetchone()['group_id']

    # Member rows + back-fill pm_boxes.group_id
    for r in rows:
        conn.execute(
            """INSERT INTO pm_box_group_members (group_id, box_id)
               VALUES (%s, %s)""",
            (new_group_id, r['box_id'])
        )
        conn.execute(
            "UPDATE pm_boxes SET group_id=%s WHERE box_id=%s",
            (new_group_id, r['box_id'])
        )

    return {
        'group_id':    new_group_id,
        'group_code':  group_code,
        'group_label': label,
        'product_id':  product_id,
        'grn_id':      grn_id,
        'grn_no':      grn_no,
        'godown_id':   godown_id,
        'member_count': member_count,
        'total_qty':   total_qty,
        'box_ids':     [int(r['box_id']) for r in rows],
    }


def _next_op_seq(conn):
    """
    Allocate the next opening-stock sequence (OP0001, OP0002, …).
    Reads the highest existing OP#### across pm_boxes.box_code and increments.
    Globally sequential — never resets.
    """
    import re as _re
    row = conn.execute("""
        SELECT box_code FROM pm_boxes
        WHERE box_code LIKE %s
        ORDER BY box_id DESC LIMIT 200
    """, ('%-OP%-B%',)).fetchall()
    max_seen = 0
    pat = _re.compile(r'-OP(\d{4,5})-B', _re.IGNORECASE)
    for r in row:
        m = pat.search(r['box_code'] or '')
        if m:
            n = int(m.group(1))
            if n > max_seen: max_seen = n
    return max_seen + 1

def _make_op_box_code(product_code, op_seq, box_seq):
    """
    Build an opening-stock box code: PRODUCTCODE-OPNNNN-BNNN
    Example: BEARTUBE12-OP0007-B003
    """
    pc = (product_code or '').upper().strip() or 'XXXXXXXXXX'
    op = 'OP' + str(int(op_seq or 0)).zfill(4)
    bs = 'B' + str(int(box_seq or 0)).zfill(3)
    return f"{pc}-{op}-{bs}"

def _create_opening_boxes(conn, *, product_id, product_code, no_of_box=None, per_box_qty=None,
                          groups=None,
                          godown_id, op_date=None, op_remarks=None, user=None):
    """
    Create N pm_boxes rows for an opening-stock entry (grn_id=0 sentinel).
    Generates a fresh OP#### sequence, writes one 'grn_create' style movement
    per box (with movement_type='adjust' since these aren't from a GRN).

    Two calling shapes (back-compat):
      - Single-group:  no_of_box=N, per_box_qty=Q
      - Multi-group:   groups=[{no_of_box, per_box_qty}, ...]
        Each group's boxes have that group's per_box_qty. All boxes get
        consecutive box_seq values 1..total under one OP label, with
        total_boxes set to the sum across all groups.

    Returns dict with op_seq, op_label, list of created box_codes,
    list of per_box_qty (one entry per box in the same order as codes).
    """
    from datetime import date as _date

    # Normalise input into a uniform list of (count, pbq) tuples.
    grp_list = []
    if groups:
        for g in groups:
            try:
                gn = int(g.get('no_of_box') or 0)
                gp = float(g.get('per_box_qty') or 0)
            except Exception:
                continue
            if gn > 0 and gp > 0:
                grp_list.append((gn, gp))
    elif no_of_box is not None:
        try:
            gn = int(no_of_box or 0); gp = float(per_box_qty or 0)
            if gn > 0 and gp > 0: grp_list.append((gn, gp))
        except Exception:
            pass

    if not grp_list:
        return {'created': 0, 'codes': [], 'per_box_qtys': [], 'op_seq': 0, 'op_label': '',
                'no_of_box': 0, 'per_box_qty': 0}

    total_boxes = sum(c for c, _ in grp_list)

    op_seq    = _next_op_seq(conn)
    op_label  = f'PM-OP/{op_seq:04d}'        # used as the box_code's grn_no field
    created_codes = []
    created_pbqs  = []
    # Parallel array to created_codes — each entry is the 8-char short_code
    # newly assigned to that box (or '' if assignment failed). Aligned 1:1
    # so the label printer can look up short_codes[i] for the QR payload
    # while keeping box_codes[i] as the printed text.
    created_short_codes = []

    seq = 0
    for grp_count, grp_pbq in grp_list:
        for _ in range(grp_count):
            seq += 1
            box_code = _make_op_box_code(product_code, op_seq, seq)
            # Idempotency safety
            exists = conn.execute(
                "SELECT box_id FROM pm_boxes WHERE box_code=%s LIMIT 1", (box_code,)
            ).fetchone()
            if exists:
                continue
            cur = conn.execute(
                """INSERT INTO pm_boxes
                     (box_code, grn_id, grn_no, grn_item_id, product_id, product_code,
                      box_seq, total_boxes, per_box_qty, current_godown_id, current_status,
                      created_by)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'in_stock',%s)""",
                (box_code, 0, op_label, 0, product_id, product_code,
                 seq, total_boxes, grp_pbq, godown_id, user)
            )
            box_id = cur.lastrowid
            sc = _assign_box_short_code(conn, box_id) or ''
            conn.execute(
                """INSERT INTO pm_box_movements
                     (box_id, movement_type, to_godown_id, qty, moved_by, remarks)
                   VALUES (%s, 'adjust', %s, %s, %s, %s)""",
                (box_id, godown_id, grp_pbq, user, op_remarks or f'Opening stock {op_label} box {seq}/{total_boxes}')
            )
            created_codes.append(box_code)
            created_pbqs.append(grp_pbq)
            created_short_codes.append(sc)

    # Back-compat fields:
    # - When multi-group, per_box_qty / no_of_box are reported as the FIRST
    #   group so existing callers that grab a single value won't crash; the
    #   authoritative per-box info is in per_box_qtys.
    first_n, first_p = grp_list[0]

    # Assign FIFO code for this opening lot (one per (op_seq, product_id)).
    # Idempotent — same call returns the same code on reprint.
    fifo_code = ''
    try:
        fi = _get_or_assign_fifo(conn, 'op', op_seq, product_id)
        fifo_code = fi.get('fifo_code', '') or ''
    except Exception as _fe:
        import sys as _sys
        print(f"[pm_stock_routes] FIFO assign failed for OP {op_seq}/{product_id}: {_fe}", file=_sys.stderr)

    return {
        'created':      len(created_codes),
        'codes':        created_codes,
        'short_codes':  created_short_codes,
        'per_box_qtys': created_pbqs,
        'op_seq':       op_seq,
        'op_label':     op_label,
        'per_box_qty':  first_p,
        'no_of_box':    total_boxes,
        'groups':       [{'no_of_box': c, 'per_box_qty': p} for c, p in grp_list],
        'fifo_code':    fifo_code,
    }

def _create_boxes_for_grn_item(conn, *, grn_id, grn_no, grn_item_id, product_id,
                               product_code, no_of_box, per_box_qty, godown_id,
                               grn_date=None, user=None, product_version=None):
    """
    Insert pm_boxes rows + pm_box_movements 'grn_create' records for one GRN item.
    Idempotent on (grn_item_id, box_seq) thanks to box_code's UNIQUE index.
    Returns count created.

    NOTE: This function does NOT touch pm_godown_txn or stock totals — callers
    handle stock movement separately. Boxes are a parallel layer on top of stock.

    `product_version` (optional) is a free-text per-line marker — e.g. "OLD DESIGN",
    "v2", "PG→Glass" — that gets copied onto every pm_boxes row so the version
    travels with each box through MTV/DN/audit. Labels append "[VERSION]" to the
    product name when rendering.

    Box-seq continuation
    --------------------
    box_code is built from (product_code, grn_no, box_seq). The UNIQUE index on
    box_code means if Item 1 of a GRN created boxes B001..B009 for a product,
    a second item for the SAME product on the same GRN trying to start at B001
    again would silently collide and lose its rows. (Operators legitimately use
    "9 full + 1 partial-box" patterns by adding two GRN lines for the same
    product.) So before inserting, we look up the highest box_seq already used
    for this (grn_no, product_id) and start the new sequence from there + 1.
    Item 1 → B001..B009; Item 2 → B010..B0NN. No collisions, every box
    scannable.
    """
    nob = int(no_of_box or 0)
    if nob <= 0:
        return 0
    pbq = float(per_box_qty or 0)

    # Find the highest box_seq already used for this product on this GRN.
    # Scoped by (grn_no, product_id) — matches the natural key of box_code,
    # so we will never produce a code that could collide.
    max_seq_row = conn.execute(
        """SELECT COALESCE(MAX(box_seq), 0) AS max_seq
           FROM pm_boxes
           WHERE grn_no = %s AND product_id = %s""",
        (grn_no, product_id)
    ).fetchone()
    start_seq = int((max_seq_row['max_seq'] if max_seq_row else 0) or 0) + 1
    end_seq   = start_seq + nob - 1

    # total_boxes printed on each label = total physical boxes of THIS product
    # on THIS GRN (across all items). Re-read after the loop so each label
    # reflects the final total when multiple items add to the same product.
    created = 0
    new_box_ids = []
    for seq in range(start_seq, end_seq + 1):
        box_code = _make_box_code(product_code, grn_no, seq)
        # Defensive idempotent check — if the row already exists (re-save of
        # a previously-saved GRN), skip silently. The continuous-seq logic
        # above means this should rarely fire, but keep it for safety.
        exists = conn.execute(
            "SELECT box_id FROM pm_boxes WHERE box_code=%s LIMIT 1", (box_code,)
        ).fetchone()
        if exists:
            continue
        cur = conn.execute(
            """INSERT INTO pm_boxes
                 (box_code, grn_id, grn_no, grn_item_id, product_id, product_code,
                  box_seq, total_boxes, per_box_qty, current_godown_id, current_status,
                  created_by, product_version)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,'in_stock',%s,%s)""",
            (box_code, grn_id, grn_no, grn_item_id, product_id, product_code,
             seq, end_seq, pbq, godown_id, user,
             (product_version or None))
        )
        box_id = cur.lastrowid
        new_box_ids.append(box_id)
        # Compact 8-char sequential short_code for the QR payload on this
        # box's label. Newly-created boxes always get one; legacy boxes
        # (created before this column existed) stay NULL and fall back to
        # box_code at scan time via _find_box_by_any_code.
        _assign_box_short_code(conn, box_id)
        conn.execute(
            """INSERT INTO pm_box_movements
                 (box_id, movement_type, to_godown_id, qty, moved_by, remarks)
               VALUES (%s, 'grn_create', %s, %s, %s, %s)""",
            (box_id, godown_id, pbq, user, f'GRN {grn_no} box {seq}/{end_seq}')
        )
        created += 1

    # If this product now has MORE boxes on this GRN than what we stamped as
    # total_boxes on earlier items (because Item 1 thought total was 9, then
    # Item 2 added a 10th), backfill total_boxes on all rows for this product
    # to the final count. Labels read total_boxes to render "X/N" — keeps
    # the printed denominator consistent across all of this product's labels.
    if created > 0:
        conn.execute(
            """UPDATE pm_boxes
               SET total_boxes = %s
               WHERE grn_no = %s AND product_id = %s""",
            (end_seq, grn_no, product_id)
        )
    return created

def _delete_boxes_for_grn(conn, grn_id):
    """
    Cascade-delete boxes + movements for a GRN. Used when a GRN is deleted or
    its items are about to be rewritten on update. Returns count deleted.
    """
    boxes = conn.execute(
        "SELECT box_id FROM pm_boxes WHERE grn_id=%s", (grn_id,)
    ).fetchall()
    if not boxes:
        return 0
    ids = [b['box_id'] for b in boxes]
    placeholders = ','.join(['%s'] * len(ids))
    conn.execute(
        f"DELETE FROM pm_box_movements WHERE box_id IN ({placeholders})", ids
    )
    conn.execute(
        f"DELETE FROM pm_boxes WHERE box_id IN ({placeholders})", ids
    )
    return len(ids)

def _get_godowns(conn):
    """Fetch locations from procurement_godowns.
    Actual schema: id, name, address, contact, phone, email, is_default,
                   type ('godown'|'billing'|'shipping'), gst_number, state, city, pin
    No is_active column — all rows are considered active.
    type='floor' treated as Factory (Production Floor).
    """
    try:
        rows = conn.execute("""
            SELECT id, name,
                   COALESCE(address,'')    AS address,
                   COALESCE(city,'')       AS city,
                   COALESCE(state,'')      AS state,
                   COALESCE(pin,'')        AS pincode,
                   COALESCE(contact,'')    AS contact,
                   COALESCE(phone,'')      AS phone,
                   COALESCE(email,'')      AS email,
                   COALESCE(gst_number,'') AS gst_number,
                   COALESCE(type,'godown') AS godown_type,
                   is_default
            FROM procurement_godowns
            ORDER BY is_default DESC, name ASC
        """).fetchall()
        return [dict(r) for r in rows]
    except Exception as e:
        # Ultra-safe fallback
        try:
            rows = conn.execute(
                "SELECT id, name FROM procurement_godowns ORDER BY name"
            ).fetchall()
            return [{'id': r['id'], 'name': r['name'], 'address': '',
                     'city': '', 'state': '', 'pincode': '',
                     'contact': '', 'phone': '', 'email': '', 'gst_number': '',
                     'godown_type': 'godown', 'is_default': 0} for r in rows]
        except Exception:
            return []

def _godown_summary(conn, product_id=None, from_date=None, to_date=None, godown_id=None):
    # Opening balance is always included regardless of date range or godown filter.
    # Opening rows are stored with godown_id=NULL (from import/add-product), so they must
    # never be excluded by the godown filter — otherwise closing stock becomes wrong.
    # Closing stock = Opening (always) + Inward (godown+date filtered) - Outward (godown+date filtered)

    # Date filter: opening always passes; inward/outward respect the date range
    movement_date_filter = ""
    movement_params = []
    if from_date and to_date:
        movement_date_filter = "AND (g.txn_type = 'opening' OR g.txn_date BETWEEN %s AND %s)"
        movement_params = [from_date, to_date]
    elif to_date:
        movement_date_filter = "AND g.txn_date <= %s"
        movement_params = [to_date]
    elif from_date:
        movement_date_filter = "AND (g.txn_type = 'opening' OR g.txn_date >= %s)"
        movement_params = [from_date]

    params_filter = movement_params[:]

    prod_filter = ""
    if product_id:
        prod_filter = "AND g.product_id = %s"
        params_filter.append(product_id)

    # Godown filter:
    # - Opening rows with godown_id IS NULL → legacy data, always include (can't attribute to any godown)
    # - Opening rows with godown_id set → include ONLY if it matches the filter
    # - Inward/Outward → include ONLY if godown_id matches
    gdwn_filter = ""
    if godown_id:
        gdwn_filter = """AND (
            (g.txn_type = 'opening' AND g.godown_id IS NULL)
            OR g.godown_id = %s
        )"""
        params_filter.append(godown_id)

    sql = f"""
        SELECT
            p.id,
            p.product_name,
            COALESCE(p.product_code,'') AS product_code,
            p.pm_type,
            COALESCE(p.brand_id,0) AS brand_id,
            COALESCE(b.name,'') AS brand_name,
            COALESCE(b.color,'') AS brand_color,
            COALESCE(p.min_stock,0) AS min_stock,
            COALESCE(SUM(CASE WHEN g.txn_type = 'opening'  THEN g.qty ELSE 0 END), 0) AS op,
            COALESCE(SUM(CASE WHEN g.txn_type = 'inward'   THEN g.qty ELSE 0 END), 0) AS inward,
            COALESCE(SUM(CASE WHEN g.txn_type = 'outward'  THEN g.qty ELSE 0 END), 0) AS outward,
            MAX(g.txn_date) AS last_txn_date
        FROM pm_products p
        LEFT JOIN procurement_brands b ON b.id = p.brand_id
        LEFT JOIN pm_godown_txn g
            ON g.product_id = p.id {movement_date_filter} {gdwn_filter}
        WHERE p.is_active = 1 {prod_filter}
        GROUP BY p.id, p.product_name, p.product_code, p.pm_type, p.brand_id, b.name, b.color
        ORDER BY p.product_name
    """
    rows = conn.execute(sql, params_filter).fetchall()
    result = []
    for r in rows:
        godown_stock = float(r['op']) + float(r['inward']) - float(r['outward'])
        result.append({
            'id':            r['id'],
            'product_name':  r['product_name'],
            'product_code':  r['product_code'] or '',
            'pm_type':       r['pm_type'],
            'brand_id':      int(r['brand_id']) if r['brand_id'] else 0,
            'brand_name':    r['brand_name'],
            'brand_color':   r['brand_color'],
            'min_stock':     int(r['min_stock']) if r['min_stock'] else 0,
            'op':            float(r['op']),
            'inward':        float(r['inward']),
            'outward':       float(r['outward']),
            'godown_stock':  godown_stock,
            'last_txn_date': str(r['last_txn_date']) if r['last_txn_date'] else '',
        })
    return result

def _floor_summary(conn, product_id=None, from_date=None, to_date=None, godown_id=None):
    # floor_opening balance is always included regardless of date range or godown filter.
    # floor_opening rows are stored with godown_id=NULL, so they must never be excluded
    # by the godown filter — otherwise remaining stock becomes wrong.
    # Remaining = floor_opening (always) + issue(filtered) - dispatch(filtered)
    #             - rejection(filtered) - pm_return(filtered)

    movement_date_filter = ""
    movement_params = []
    if from_date and to_date:
        movement_date_filter = "AND (f.txn_type = 'floor_opening' OR f.txn_date BETWEEN %s AND %s)"
        movement_params = [from_date, to_date]
    elif to_date:
        movement_date_filter = "AND f.txn_date <= %s"
        movement_params = [to_date]
    elif from_date:
        movement_date_filter = "AND (f.txn_type = 'floor_opening' OR f.txn_date >= %s)"
        movement_params = [from_date]

    params_filter = movement_params[:]

    prod_filter = ""
    if product_id:
        prod_filter = "AND f.product_id = %s"
        params_filter.append(product_id)

    # Godown filter: floor_opening rows (godown_id IS NULL) are always included;
    # movement types are filtered to the selected godown only.
    gdwn_filter = ""
    if godown_id:
        gdwn_filter = "AND (f.txn_type = 'floor_opening' OR f.godown_id = %s)"
        params_filter.append(godown_id)

    sql = f"""
        SELECT
            p.id,
            p.product_name,
            COALESCE(p.product_code,'') AS product_code,
            p.pm_type,
            COALESCE(b.name,'') AS brand_name,
            COALESCE(b.color,'') AS brand_color,
            COALESCE(SUM(CASE WHEN f.txn_type = 'floor_opening' THEN f.qty ELSE 0 END), 0) AS floor_op,
            COALESCE(SUM(CASE WHEN f.txn_type = 'issue'         THEN f.qty ELSE 0 END), 0) AS issue,
            COALESCE(SUM(CASE WHEN f.txn_type = 'dispatch'      THEN f.qty ELSE 0 END), 0) AS dispatch,
            COALESCE(SUM(CASE WHEN f.txn_type = 'rejection'     THEN f.qty ELSE 0 END), 0) AS rejection,
            COALESCE(SUM(CASE WHEN f.txn_type = 'pm_return'     THEN f.qty ELSE 0 END), 0) AS pm_return,
            MAX(f.txn_date) AS last_txn_date
        FROM pm_products p
        LEFT JOIN procurement_brands b ON b.id = p.brand_id
        LEFT JOIN pm_floor_txn f
            ON f.product_id = p.id {movement_date_filter} {gdwn_filter}
        WHERE p.is_active = 1 {prod_filter}
        GROUP BY p.id, p.product_name, p.product_code, p.pm_type, b.name, b.color
        ORDER BY p.product_name
    """
    rows = conn.execute(sql, params_filter).fetchall()
    result = []
    for r in rows:
        remaining = (float(r['floor_op']) + float(r['issue'])
                     - float(r['dispatch']) - float(r['rejection']) - float(r['pm_return']))
        result.append({
            'id':            r['id'],
            'product_name':  r['product_name'],
            'product_code':  r['product_code'] or '',
            'pm_type':       r['pm_type'],
            'brand_name':    r['brand_name'],
            'brand_color':   r['brand_color'],
            'floor_op':      float(r['floor_op']),
            'issue':         float(r['issue']),
            'dispatch':      float(r['dispatch']),
            'rejection':     float(r['rejection']),
            'pm_return':     float(r['pm_return']),
            'remaining':     remaining,
            'last_txn_date': str(r['last_txn_date']) if r['last_txn_date'] else '',
        })
    return result

def _is_admin():
    return (session.get('User_Type','').lower() == 'admin')

def _user_designation(conn=None):
    """Return the current user's designation (lowercased) from user_tbl, or ''
    if unavailable. Cached on the session for the request's convenience is
    avoided — designation rarely matters per-request and a fresh read is safe."""
    uname = session.get('User_Name') or session.get('UID')
    if not uname:
        return ''
    _own = False
    try:
        if conn is None:
            conn = sampling_portal.get_db_connection(); _own = True
        row = conn.execute(
            "SELECT COALESCE(designation,'') AS d FROM user_tbl WHERE username=%s LIMIT 1",
            (uname,)
        ).fetchone()
        return (row['d'] if row else '').strip().lower()
    except Exception:
        return ''
    finally:
        if _own:
            try: conn.close()
            except Exception: pass

def _is_manager(conn=None):
    """True if the current user is a Manager (by designation) OR an admin.
    Used to gate the Material Lock feature."""
    if _is_admin():
        return True
    return 'manager' in _user_designation(conn)

def _is_out_creator(conn, transfer_id):
    """Return True if the CURRENT user created the OUT side of this transfer.
    Used to enforce separation of duties — the person who creates Material OUT
    must NOT be the same person who confirms / scans / saves the Material IN
    side for the same transaction. Admins are exempt (they can always act, e.g.
    to reconcile discrepancies)."""
    if _is_admin():
        return False
    try:
        r = conn.execute(
            "SELECT out_by FROM pm_transfers WHERE transfer_id=%s", (transfer_id,)
        ).fetchone()
    except Exception:
        return False
    if not r:
        return False
    out_by = (r['out_by'] or '').strip().lower()
    me = (_user() or '').strip().lower()
    return bool(out_by) and bool(me) and out_by == me

VOUCHER_TYPES = ('grn', 'mtv', 'dn', 'opening')

def _voucher_type_enabled(conn, voucher_type):
    """Return True if non-admins are allowed to create vouchers of this type.
    Admins always pass — caller still needs to gate by role first if it cares.
    Unknown types default to True (don't break unrelated flows)."""
    if voucher_type not in VOUCHER_TYPES:
        return True
    try:
        r = conn.execute(
            "SELECT enabled FROM pm_voucher_permissions WHERE voucher_type=%s",
            (voucher_type,)
        ).fetchone()
    except Exception:
        return True
    if not r:
        return True
    return bool(r['enabled'])

def _block_if_disabled(voucher_type, conn=None):
    """If the current user is non-admin AND the voucher_type is disabled,
    return a (jsonify, status_code) tuple to short-circuit a route. Else None.
    The caller passes back ``return _block_if_disabled(...)`` directly."""
    if _is_admin():
        return None
    close_after = False
    if conn is None:
        conn = sampling_portal.get_db_connection()
        close_after = True
    try:
        ok = _voucher_type_enabled(conn, voucher_type)
    finally:
        if close_after:
            try: conn.close()
            except Exception: pass
    if ok:
        return None
    label = {
        'grn':     'GRN',
        'mtv':     'Material Transfer (MTV / Material OUT)',
        'dn':      'Delivery Note',
        'opening': 'Opening Stock / Add Product'
    }.get(voucher_type, voucher_type.upper())
    return (jsonify({
        'status': 'error',
        'code':   'voucher_disabled',
        'voucher_type': voucher_type,
        'message': f'Disabled by admin: creating new {label} vouchers is blocked for your role. View / print existing vouchers is still available. Contact an admin to re-enable.'
    }), 403)


def _block_if_requester():
    """Server-side guard for routes that requesters (FACTORY users) must
    NOT be able to invoke. Mirrors _block_if_disabled — returns a
    (jsonify, status_code) tuple to short-circuit the route, or None
    when the caller is allowed through.

    Admins always pass. Non-admin FACTORY users are blocked. Everyone
    else passes. Use on endpoints that create or modify vouchers
    (GRN save, transfer create, allotment start, etc.) — the UI already
    hides the buttons but a hand-crafted POST would bypass the UI.
    """
    try:
        if _user_is_requester():
            return (jsonify({
                'status':  'error',
                'code':    'requester_blocked',
                'message': 'This action is not available for requester accounts. Submit a Material Request instead.'
            }), 403)
    except Exception:
        pass  # fail-open: prefer letting the request through over a false-positive block
    return None


def _json_safe(v):
    """Coerce a single value into a JSON-serialisable form. Handles dates,
    datetimes, Decimals, bytes."""
    if v is None:
        return None
    if isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, (datetime, date)):
        return v.isoformat()
    if isinstance(v, bytes):
        try: return v.decode('utf-8')
        except Exception: return v.hex()
    # Decimal and any other type → str
    return str(v)

def _row_to_dict(row):
    """Convert a DB row (DictCursor / sqlite3.Row / dict) to a JSON-safe dict."""
    if row is None:
        return None
    if isinstance(row, dict):
        d = dict(row)
    else:
        try:
            d = dict(row)
        except Exception:
            d = {k: row[k] for k in row.keys()}
    return {k: _json_safe(v) for k, v in d.items()}

def _bin_soft_delete(conn, *, entity_type, entity_id, entity_label,
                     parent_table, parent_where, parent_params,
                     children=None, summary=None, reason=None):
    """
    Snapshot a record (and optionally its children + auto-posted ledger txns)
    into pm_recycle_bin, then DELETE the originals. All inside the caller's
    transaction — the caller commits when satisfied.

    Args:
        entity_type: short tag like 'grn', 'mtv', 'dn', 'transfer'
        entity_id: numeric id of the parent record
        entity_label: human-readable label, e.g. 'GRN PM-GRN/0042/26-27'
        parent_table: table name of the parent row
        parent_where: WHERE clause (without 'WHERE'), e.g. 'id=%s'
        parent_params: tuple of params for parent_where
        children: optional list of dicts:
                  [{'table': 'pm_grn_items', 'where': 'grn_id=%s', 'params': (gid,)}]
                  All matching rows are snapshotted and deleted.
        summary: optional VARCHAR(500) human-readable summary
        reason: optional reason text from the user

    Returns: bin_id of the new pm_recycle_bin row.

    Raises: any DB error (caller should rollback).
    """
    # Strip any trailing ORDER BY ... / LIMIT N from the parent_where so
    # callers can't accidentally produce "WHERE ... ORDER BY x LIMIT 1
    # LIMIT 1" (a MySQL syntax error). The helper provides its own
    # LIMIT 1 for the SELECT, and the DELETE is intentionally unbounded
    # because in every current caller the same predicate selects the
    # entire row set we want to remove.
    import re as _re
    _clean_where = _re.sub(
        r'\s+(?:ORDER\s+BY|LIMIT)\s+.*$', '', parent_where,
        flags=_re.IGNORECASE | _re.DOTALL
    )

    # 1. Snapshot the parent
    parent_row = conn.execute(
        f"SELECT * FROM {parent_table} WHERE {_clean_where} LIMIT 1",
        parent_params
    ).fetchone()
    if not parent_row:
        raise ValueError(f"Cannot soft-delete: {parent_table} row not found")

    payload = {
        'parent_table': parent_table,
        'parent':       _row_to_dict(parent_row),
        'children':     {}
    }

    # 2. Snapshot children
    if children:
        for c in children:
            ctbl   = c['table']
            cwhere = c['where']
            cparam = c.get('params', ())
            crows = conn.execute(
                f"SELECT * FROM {ctbl} WHERE {cwhere}",
                cparam
            ).fetchall()
            payload['children'][ctbl] = {
                'where':  cwhere,
                'rows':   [_row_to_dict(r) for r in crows]
            }

    # 3. Insert into recycle bin BEFORE deleting (so a delete failure leaves no
    #    orphan bin entry and a snapshot failure leaves the original alive)
    payload_json = json.dumps(payload, ensure_ascii=False, default=_json_safe)
    cur = conn.execute(
        """INSERT INTO pm_recycle_bin
              (entity_type, entity_label, entity_id, payload, payload_summary,
               deleted_by, reason)
            VALUES (%s, %s, %s, %s, %s, %s, %s)""",
        (entity_type,
         (entity_label or '')[:200],
         int(entity_id) if entity_id is not None else None,
         payload_json,
         (summary or '')[:500] if summary else None,
         _user(),
         (reason or '')[:500] if reason else None)
    )
    bin_id = cur.lastrowid

    # 4. Delete children first (FK-friendly), then parent
    if children:
        for c in children:
            conn.execute(
                f"DELETE FROM {c['table']} WHERE {c['where']}",
                c.get('params', ())
            )
    conn.execute(
        f"DELETE FROM {parent_table} WHERE {_clean_where}",
        parent_params
    )

    return bin_id

def _bin_restore(conn, bin_id):
    """Re-INSERT the snapshotted rows from a pm_recycle_bin entry. Preserves
    original primary keys. Marks the bin row as restored. Caller commits.

    Returns: dict with {'entity_type', 'entity_id', 'restored_at'}.
    Raises ValueError if bin_id not found, already restored, or row already
    exists (which would cause a duplicate-key error).
    """
    row = conn.execute(
        "SELECT * FROM pm_recycle_bin WHERE bin_id=%s",
        (bin_id,)
    ).fetchone()
    if not row:
        raise ValueError(f"Bin entry {bin_id} not found")
    if row['restored_at'] is not None:
        raise ValueError(f"Bin entry {bin_id} was already restored at {row['restored_at']}")

    try:
        payload = json.loads(row['payload'] or '{}')
    except Exception as e:
        raise ValueError(f"Bin entry payload is corrupted: {e}")

    parent_table = payload.get('parent_table')
    parent_data  = payload.get('parent') or {}
    children     = payload.get('children') or {}
    if not parent_table or not parent_data:
        raise ValueError("Bin entry missing parent_table or parent data")

    # Re-INSERT parent first
    _reinsert_row(conn, parent_table, parent_data)

    # Then children
    for ctbl, cinfo in children.items():
        for crow in (cinfo.get('rows') or []):
            _reinsert_row(conn, ctbl, crow)

    # Mark restored
    conn.execute(
        "UPDATE pm_recycle_bin SET restored_at=NOW(), restored_by=%s WHERE bin_id=%s",
        (_user(), bin_id)
    )

    return {
        'entity_type': row['entity_type'],
        'entity_id':   row['entity_id'],
        'bin_id':      bin_id
    }

def _reinsert_row(conn, table, data):
    """INSERT a row into a table from a dict. Used by _bin_restore."""
    if not data:
        return
    cols = list(data.keys())
    placeholders = ','.join(['%s'] * len(cols))
    col_list     = ','.join(f"`{c}`" for c in cols)
    values = [data[c] for c in cols]
    conn.execute(
        f"INSERT INTO `{table}` ({col_list}) VALUES ({placeholders})",
        values
    )

def _bin_purge(conn, bin_id):
    """Permanently delete a bin entry. Used for hard-purge from bin. Once this
    runs the data is unrecoverable. Admin-only at the route level."""
    conn.execute("DELETE FROM pm_recycle_bin WHERE bin_id=%s", (bin_id,))

VALID_REPRINT_SCOPES = ('voucher_grn', 'voucher_op', 'boxes')

def _gen_print_token():
    """A short, URL-safe, non-guessable token for redeeming a reprint."""
    return secrets.token_urlsafe(24)

def _user_home_godown(conn=None):
    """Return the locked godown_id for the current user, or None if not set
    (or user is admin — admins are never locked)."""
    if _is_admin():
        return None
    user = _user()
    if not user or user == 'Unknown':
        return None
    close_after = False
    if conn is None:
        conn = sampling_portal.get_db_connection()
        close_after = True
    try:
        row = conn.execute(
            "SELECT godown_id FROM pm_user_home_godown WHERE user_name=%s LIMIT 1",
            (user,)
        ).fetchone()
        return int(row['godown_id']) if row else None
    except Exception:
        return None
    finally:
        if close_after:
            try: conn.close()
            except Exception: pass


def _user_is_requester(conn=None):
    """Return True if the current user is a 'requester-only' user.

    A requester is a non-admin whose home godown is FACTORY (matched by
    name OR by the godown's `type='floor'` field — production-floor
    locations are always factories). Requesters get a restricted UI:
    only Material Request, Stock view, and Material IN. They can't
    create GRNs, MTVs, audits, reports, etc.

    Admins are never requesters — they bypass all restrictions and see
    everything regardless of which godown they're at.

    Returns False on any error / no home godown set, so the default
    (full UI) is preserved if anything goes wrong with the lookup.
    """
    if _is_admin():
        return False
    user = _user()
    if not user or user == 'Unknown':
        return False
    close_after = False
    if conn is None:
        conn = sampling_portal.get_db_connection()
        close_after = True
    try:
        # Two-step: get home godown id, then look up its name + type.
        # We could JOIN this in one query but the two-step is clearer
        # and the rows are small (one user, one godown).
        row = conn.execute(
            """SELECT g.id, COALESCE(g.name,'') AS name,
                      COALESCE(g.type,'') AS gtype
               FROM pm_user_home_godown h
               JOIN procurement_godowns g ON g.id = h.godown_id
               WHERE h.user_name=%s LIMIT 1""",
            (user,)
        ).fetchone()
        if not row:
            return False
        name  = (row.get('name') or '').upper().strip()
        gtype = (row.get('gtype') or '').lower().strip()
        # "FACTORY" by name OR type='floor' (which UI displays as FACTORY).
        # Be lenient with the name check so 'Factory', 'FACTORY', 'New Factory'
        # all match.
        if 'FACTORY' in name:
            return True
        if gtype == 'floor':
            return True
        return False
    except Exception:
        return False
    finally:
        if close_after:
            try: conn.close()
            except Exception: pass


# ═══════════════════════════════════════════════════════════════════════
# Per-user access control (pm_user_access table)
# ═══════════════════════════════════════════════════════════════════════
#
# Seven boolean categories the admin can toggle per-user. Defaults are
# ALL TRUE — a user with no row in pm_user_access sees the full UI just
# like before. Admins always bypass these checks (no row needed, always
# returns True).
#
# Categories (must match the column names in pm_user_access):
#   voucher_log           — Voucher Log tab + voucher detail view
#   reprint_requests      — "My Reprint Requests" sidebar item
#   opening_labels        — Opening Stock voucher + opening labels
#   grn_labels            — GRN label printing (post-save)
#   material_request      — Material Request tab + sidebar
#   stock_pages           — Stock view, Combined, Godown tabs
#   new_voucher_entries   — Creating new GRN/DN/MTV/Allotment (master switch)
#   material_lock         — Material Lock manager (lock/allow material from OUT)
#   label_reissue         — Label Reissue approvals (approve/reject reissue reqs)
#   fifo_override         — FIFO Override approvals (approve/reject FIFO bypass)
PM_USER_ACCESS_KEYS = (
    'voucher_log',
    'reprint_requests',
    'opening_labels',
    'grn_labels',
    'material_request',
    'stock_pages',
    'new_voucher_entries',
    'material_lock',
    'label_reissue',
    'fifo_override',
    'stock_adjustment',
    'pm_trs',
    'bom_manage',
    # ── Sidebar fine-grained flags (June 2026 expansion) ──
    'combined_view',
    'split_box',
    'products',
    'suppliers',
    'voucher_settings',
    'material_movement',
    'purchase_orders',
    'reports',
    'command_palette',
)

# Sensitive control features that DEFAULT TO DENY: a user with no row in
# pm_user_access (or a NULL value) does NOT get these. Admins must grant
# them explicitly. The original categories stay fail-open (default allow).
PM_USER_ACCESS_DENY_BY_DEFAULT = (
    'material_lock',
    'label_reissue',
    'fifo_override',
    'bom_manage',
)


def _user_access_dict(user=None, conn=None):
    """Return a dict of {category: bool} for the given user (or current user
    if None). All-True for admins; for any other user this returns the
    DB-stored flags from pm_user_access (or the user's group, if assigned).
    Users with NO row and NO group get all-False — i.e. they see nothing.

    Default policy changed from fail-open to **deny-all** (June 2026):
    admins must explicitly grant access via the User Access Control modal
    for each non-admin user. Previously, normal categories defaulted to
    True and only sensitive ones defaulted to False, which let any new
    user opening the page see all the normal features automatically.

    Used by:
      - pm_stock_page to inject `access` into the Jinja template
      - Frontend JS via window._userAccess for client-side gating
      - Backend route guards via _user_has_access / _block_if_no_access
    """
    # Admins always have full access — short-circuit before hitting the DB.
    if user is None and _is_admin():
        return {k: True for k in PM_USER_ACCESS_KEYS}
    uname = user if user is not None else _user()

    def _defaults():
        # Deny-all policy: no row + no group = no access. Admin must
        # explicitly grant each user in UAC.
        return {k: False for k in PM_USER_ACCESS_KEYS}

    if not uname or uname == 'Unknown':
        return _defaults()
    # If we were asked about a specific named user (e.g. admin tool list),
    # do NOT short-circuit on admin status — the admin tool wants to show
    # the table contents verbatim. Only the "current user" lookup gets the
    # admin bypass above.
    close_after = False
    if conn is None:
        conn = sampling_portal.get_db_connection()
        close_after = True
    try:
        # The session-stored name (`uname`) may be either the login
        # username OR the full_name, depending on how the parent portal
        # set the session. pm_user_access rows are keyed by the canonical
        # username (matches the dropdown in the admin UI), so we try the
        # canonical resolution first, then the verbatim session name as
        # fallback. This covers:
        #   * session has login username + row keyed by username (clean case)
        #   * session has full_name + row keyed by username (the common bug)
        #   * either-or for legacy rows saved by older code paths
        candidates = []
        canonical = _resolve_canonical_username(uname)
        candidates.append(canonical)
        if uname != canonical:
            candidates.append(uname)

        cols = ", ".join(PM_USER_ACCESS_KEYS)
        row = None
        matched_name = None
        for cand in candidates:
            row = conn.execute(
                f"SELECT {cols} FROM pm_user_access WHERE user_name=%s LIMIT 1",
                (cand,)
            ).fetchone()
            if row:
                matched_name = cand
                break

        if not row:
            # No explicit per-user row under any candidate → fall back to
            # the user's GROUP access (try canonical name first), else
            # deny-all defaults.
            for cand in candidates:
                grp = _group_access_for_user(cand, conn)
                if grp is not None:
                    return grp
            return _defaults()
        out = {}
        for k in PM_USER_ACCESS_KEYS:
            v = row.get(k) if hasattr(row, 'get') else row[k]
            # NULL on an existing row = deny (under the new deny-all
            # default). This handles freshly-added columns on existing
            # rows: until the admin explicitly toggles them on, they
            # stay off.
            if v is None:
                out[k] = False
            else:
                out[k] = bool(int(v))
        return out
    except Exception:
        # Fail-closed across the board on any DB error.
        return _defaults()
    finally:
        if close_after:
            try: conn.close()
            except Exception: pass


def _group_access_for_user(uname, conn):
    """Return the access dict from the user's assigned group, or None if the
    user isn't in any group (or on error). Used as the fallback layer in
    _user_access_dict between the per-user row and the defaults."""
    try:
        mem = conn.execute(
            "SELECT group_id FROM pm_access_group_members WHERE user_name=%s LIMIT 1",
            (uname,)
        ).fetchone()
        if not mem:
            return None
        cols = ", ".join(PM_USER_ACCESS_KEYS)
        grow = conn.execute(
            f"SELECT {cols} FROM pm_access_groups WHERE group_id=%s LIMIT 1",
            (mem['group_id'],)
        ).fetchone()
        if not grow:
            return None
        out = {}
        for k in PM_USER_ACCESS_KEYS:
            v = grow.get(k) if hasattr(grow, 'get') else grow[k]
            # NULL on group row = deny (same deny-all default as
            # _user_access_dict applies to per-user rows). The admin
            # must explicitly toggle each flag on the group.
            out[k] = False if v is None else bool(int(v))
        return out
    except Exception:
        return None


def _user_has_access(category, user=None, conn=None):
    """Check a single category for the current (or named) user. Admins always
    pass. Unknown category strings return True (defensive — better to
    over-grant than to break a route by typo).

    Under the deny-all default policy: if the category exists in
    PM_USER_ACCESS_KEYS but is missing from the resolved dict (e.g. a
    user with no row and no group), this returns False."""
    if category not in PM_USER_ACCESS_KEYS:
        return True
    # Admin bypass when checking the current user. If a specific user is
    # named (admin tool listing other users), we DO consult the table.
    if user is None and _is_admin():
        return True
    d = _user_access_dict(user=user, conn=conn)
    # Default False (deny) when the key isn't in the dict — matches the
    # _defaults() policy of returning False for every key.
    return bool(d.get(category, False))


def _block_if_no_access(category):
    """Return a (jsonify, status) tuple to short-circuit a route when the
    current user lacks access to `category`. None when allowed.

    Same usage pattern as _block_if_disabled / _block_if_requester:
        blocked = _block_if_no_access('new_voucher_entries')
        if blocked is not None: return blocked

    Under the deny-all policy: any error during the access lookup is
    treated as denial (fail-closed). Previously this was fail-open,
    which would let any error in the access path silently grant access.
    """
    try:
        if _user_has_access(category):
            return None
    except Exception:
        # Fail-CLOSED on lookup errors under the deny-all policy.
        nice = category.replace('_', ' ').title()
        return jsonify({
            'status':  'error',
            'message': f'Could not verify your access to "{nice}". Contact admin.',
        }), 403
    nice = {
        'voucher_log':         'Voucher Log',
        'reprint_requests':    'Reprint Requests',
        'opening_labels':      'Opening Stock Labels',
        'grn_labels':          'GRN Labels',
        'material_request':    'Material Request',
        'stock_pages':         'Stock Pages',
        'new_voucher_entries': 'New Voucher Entries',
        'stock_adjustment':    'Stock Adjustment',
        'pm_trs':              'PM TRS (Testing Requisition)',
    }.get(category, category.replace('_', ' ').title())
    uname = _user() or 'Unknown'
    return (jsonify({
        'status':  'error',
        'code':    'access_denied',
        'category': category,
        'user_name': uname,
        'message': f'Access denied for "{uname}": no permission for "{nice}". Open the User Access Control modal as admin to grant access.'
    }), 403)

def _enforce_home_godown(conn, *fields):
    """For each field name → godown_id passed in (varargs), assert that the
    value matches the user's home godown. Admins always pass.
    Pass tuples like ('source_godown_id', 12), ('dest_godown_id', 5).
    Returns (ok, error_message). On admin or no home set, ok=True."""
    if _is_admin():
        return True, None
    home = _user_home_godown(conn)
    if home is None:
        return True, None  # User has no home set → no lock applied
    bad = []
    for name, val in fields:
        if val is None: continue
        if int(val) != int(home):
            bad.append(f"{name} (got {val}, expected {home})")
    if bad:
        gname = ''
        try:
            r = conn.execute("SELECT name FROM procurement_godowns WHERE id=%s", (home,)).fetchone()
            if r: gname = r['name']
        except Exception:
            pass
        return False, f"Location locked to your home godown ({gname or '#'+str(home)}). Attempted: {', '.join(bad)}"
    return True, None

def _verify_reprint_auth(conn, *, scope_type, voucher_kind, voucher_id,
                         req_id=None, token=None,
                         expected_product_id=None, expected_godown_id=None,
                         expected_new_nob=None, expected_new_pbq=None):
    """Check that the caller is allowed to do an edit reprint.

    Returns (ok, error_response_or_none).
    Allowed if:
      - caller is admin (no token needed), OR
      - req_id + token are provided and refer to an approved request matching
        the scope, voucher, requester, and edit values being performed.

    On success the matching request row (if any) is also marked 'printed'
    inside the transaction.
    """
    if _is_admin():
        return True, None, None

    if not req_id or not token:
        return False, (jsonify({
            'status': 'error',
            'message': 'Non-admins must supply req_id + token from an approved request'
        }), 403), None

    row = conn.execute(
        """SELECT * FROM pm_label_reprint_requests
           WHERE req_id=%s AND print_token=%s""",
        (req_id, token)
    ).fetchone()
    if not row:
        return False, (jsonify({'status':'error','message':'Invalid request or token'}), 404), None
    if row['status'] != 'approved':
        return False, (jsonify({
            'status':'error',
            'message': f"Request status is '{row['status']}'. Only approved requests can be redeemed."
        }), 409), None
    if row['requested_by'] != _user():
        return False, (jsonify({'status':'error','message':'Only the original requester can redeem'}), 403), None
    if row['scope_type'] != scope_type or (row['voucher_kind'] or '') != (voucher_kind or '') or int(row['voucher_id'] or 0) != int(voucher_id or 0):
        return False, (jsonify({'status':'error','message':'Token scope does not match this request'}), 400), None
    # The new dimensions in the URL must match what the admin approved.
    # If the request did NOT include edits, but the caller is sending edits,
    # reject — they need a fresh request with edits explicitly approved.
    req_nob = row['new_no_of_box']
    req_pbq = float(row['new_per_box_qty']) if row['new_per_box_qty'] is not None else None
    if expected_new_nob is not None and (req_nob != expected_new_nob):
        return False, (jsonify({'status':'error','message':f'Requested no_of_box ({expected_new_nob}) does not match approved value ({req_nob}). Submit a new request with the desired values.'}), 400), None
    if expected_new_pbq is not None:
        if req_pbq is None or abs(req_pbq - float(expected_new_pbq)) > 0.0001:
            return False, (jsonify({'status':'error','message':f'Requested per_box_qty ({expected_new_pbq}) does not match approved value ({req_pbq}). Submit a new request with the desired values.'}), 400), None
    if expected_product_id is not None and (row['product_id'] is None or int(row['product_id']) != int(expected_product_id)):
        return False, (jsonify({'status':'error','message':'Token product mismatch'}), 400), None
    if expected_godown_id is not None and (row['godown_id'] is None or int(row['godown_id']) != int(expected_godown_id)):
        return False, (jsonify({'status':'error','message':'Token godown mismatch'}), 400), None

    # Mark printed (single-use) — caller's transaction will commit on success
    conn.execute(
        """UPDATE pm_label_reprint_requests
           SET status='printed', printed_at=NOW(), printed_by=%s, print_token=NULL
           WHERE req_id=%s""",
        (_user(), req_id)
    )
    return True, None, row

def _log_transfer_edit(conn, transfer_id, action, details=None):
    """Append a row to pm_transfer_edits. Safe to call inside the active transaction."""
    try:
        conn.execute(
            """INSERT INTO pm_transfer_edits (transfer_id, action, edited_by, details)
               VALUES (%s, %s, %s, %s)""",
            (int(transfer_id), action, _user(), (details or None))
        )
    except Exception:
        # Don't let audit logging break the actual operation.
        pass

def _is_floor_godown(conn, godown_id):
    """Return True if this godown is a factory/floor location.

    Floor identification:
      - Primary: procurement_godowns.type = 'floor'
      - Fallback: name (case-insensitive) is 'factory', 'factory floor',
        'production floor', or contains 'floor' — covers misconfigured data
        where the type column was never set to 'floor' but the location
        clearly is a factory floor (no opening balance posting, only
        receives goods via transfers, never via direct GRN).
    """
    if not godown_id:
        return False
    row = conn.execute(
        "SELECT COALESCE(type,'') AS t, LOWER(COALESCE(name,'')) AS n "
        "FROM procurement_godowns WHERE id=%s",
        (int(godown_id),)
    ).fetchone()
    if not row:
        return False
    if (row['t'] or '').lower() == 'floor':
        return True
    name = (row['n'] or '').strip()
    return name in ('factory', 'factory floor', 'production floor') or 'floor' in name.split()

def _post_stock_movement(conn, *, product_id, godown_id, qty, direction,
                         transfer_no, transfer_id, txn_date, user):
    """
    Write a stock txn row for a transfer. direction in ('out','in').
    Picks pm_godown_txn or pm_floor_txn based on godown type.

    Floor txn_type is constrained by an ENUM that only accepts
    ('floor_opening','issue','dispatch','rejection','pm_return').
    The floor-stock summary formula is:
        remaining = floor_opening + issue − dispatch − rejection − pm_return
    So we map:
        direction='in'  → 'issue'    (adds to remaining)
        direction='out' → 'dispatch' (subtracts from remaining)
    Godown txn_type ENUM is ('opening','inward','outward').
    """
    is_floor = _is_floor_godown(conn, godown_id)
    remarks = f"[PM-MT:{transfer_no}] {('OUT' if direction=='out' else 'IN')}"
    if is_floor:
        # Use 'issue' for inflow, 'dispatch' for outflow — both are valid
        # enum values AND are correctly summed in the floor-stock formula.
        txn_type = 'dispatch' if direction == 'out' else 'issue'
        conn.execute(
            """INSERT INTO pm_floor_txn (product_id, txn_date, txn_type, qty, remarks, created_by, godown_id, voucher_no)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
            (product_id, txn_date, txn_type, abs(float(qty)),
             remarks, user, godown_id, transfer_no)
        )
    else:
        # 'inward'/'outward' are the only valid values in the godown txn enum.
        txn_type = 'outward' if direction == 'out' else 'inward'
        conn.execute(
            """INSERT INTO pm_godown_txn (product_id, txn_date, txn_type, qty, remarks, created_by, voucher_no, godown_id)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s)""",
            (product_id, txn_date, txn_type, abs(float(qty)),
             remarks, user, transfer_no, godown_id)
        )

def _refresh_transfer_totals(conn, tid):
    """Recompute total_boxes/total_qty on pm_transfers from OUT line items."""
    row = conn.execute(
        """SELECT COALESCE(SUM(no_of_box),0) AS nob,
                  COALESCE(SUM(total_qty),0) AS qty
           FROM pm_transfer_items WHERE transfer_id=%s AND side='out'""",
        (tid,)
    ).fetchone()
    conn.execute(
        "UPDATE pm_transfers SET total_boxes=%s, total_qty=%s WHERE transfer_id=%s",
        (int(row['nob'] or 0), float(row['qty'] or 0), tid)
    )

def _check_discrepancy(conn, tid):
    """
    Compare OUT vs IN line items per product. If any product's no_of_box or
    total_qty differs, mark has_discrepancy=1; else clear it.
    Returns (has_discrepancy, mismatches_list).

    IMPORTANT: If the transfer has already been admin-reconciled (its
    discrepancy_note starts with 'RECONCILED:'), this function will NOT
    re-flag the transfer as discrepant or overwrite the note, even if the
    line-item totals still differ. Reconciliation works by posting delta
    stock movements at source — the line items intentionally stay as
    originally scanned, so a naive line-by-line comparison would always
    re-trigger the flag and erase the admin's resolution. The mismatches
    list is still computed and returned (callers may want to display it),
    but the database write is skipped.
    """
    # Aggregate by product_id on each side BEFORE comparing. We do this
    # defensively (in addition to the schema's unique key) because some
    # legacy installations accumulated multiple rows per
    # (transfer_id, side, product_id) before the unique key was added.
    # Without aggregation, the LEFT JOIN cartesian-explodes N OUT rows
    # against M IN rows of the same product into N×M ghost mismatches.
    # Aggregating to a single row per product per side guarantees one
    # mismatch entry per product no matter how many physical rows exist.
    rows = conn.execute(
        """SELECT
              o.product_id,
              po.product_name,
              o.out_box, o.out_qty,
              COALESCE(i.in_box, 0) AS in_box,
              COALESCE(i.in_qty, 0) AS in_qty
           FROM (
              SELECT product_id,
                     SUM(no_of_box) AS out_box,
                     SUM(total_qty) AS out_qty
              FROM pm_transfer_items
              WHERE transfer_id=%s AND side='out'
              GROUP BY product_id
           ) o
           LEFT JOIN (
              SELECT product_id,
                     SUM(no_of_box) AS in_box,
                     SUM(total_qty) AS in_qty
              FROM pm_transfer_items
              WHERE transfer_id=%s AND side='in'
              GROUP BY product_id
           ) i ON i.product_id = o.product_id
           LEFT JOIN pm_products po ON po.id = o.product_id

           UNION

           SELECT
              i2.product_id,
              p2.product_name,
              0, 0,
              i2.in_box, i2.in_qty
           FROM (
              SELECT product_id,
                     SUM(no_of_box) AS in_box,
                     SUM(total_qty) AS in_qty
              FROM pm_transfer_items
              WHERE transfer_id=%s AND side='in'
              GROUP BY product_id
           ) i2
           LEFT JOIN pm_products p2 ON p2.id = i2.product_id
           WHERE i2.product_id NOT IN (
              SELECT product_id FROM pm_transfer_items
              WHERE transfer_id=%s AND side='out'
           )""",
        (tid, tid, tid, tid)
    ).fetchall()
    mismatches = []
    for r in rows:
        ob, ib = int(r['out_box'] or 0), int(r['in_box'] or 0)
        oq, iq = float(r['out_qty'] or 0), float(r['in_qty'] or 0)
        if ob != ib or abs(oq - iq) > 0.001:
            mismatches.append({
                'product_id':   r['product_id'],
                'product_name': r['product_name'],
                'out_box': ob, 'out_qty': oq,
                'in_box':  ib, 'in_qty':  iq,
                'box_delta': ib - ob,
                'qty_delta': iq - oq
            })
    has_d = len(mismatches) > 0

    # ── Preserve admin reconciliation ────────────────────────────────────
    # If this transfer was previously reconciled, the line-item mismatch is
    # the historical record (kept for audit). Do NOT overwrite has_discrepancy
    # or the note — that would silently un-reconcile the transfer.
    existing = conn.execute(
        "SELECT has_discrepancy, COALESCE(discrepancy_note,'') AS note FROM pm_transfers WHERE transfer_id=%s",
        (tid,)
    ).fetchone()
    if existing and (existing.get('note') or '').startswith('RECONCILED:'):
        # Trust the reconciled state. Return mismatches for display purposes
        # but report has_discrepancy as the stored value (should be 0).
        return bool(existing.get('has_discrepancy')), mismatches

    note  = None
    if has_d:
        # Compact text summary of discrepancies (first 3)
        bits = []
        for m in mismatches[:3]:
            bits.append(f"{m['product_name']}: out {m['out_box']}box/{m['out_qty']} vs in {m['in_box']}box/{m['in_qty']}")
        note = '; '.join(bits)
        if len(mismatches) > 3:
            note += f" (+{len(mismatches)-3} more)"
    conn.execute(
        "UPDATE pm_transfers SET has_discrepancy=%s, discrepancy_note=%s WHERE transfer_id=%s",
        (1 if has_d else 0, note, tid)
    )
    return has_d, mismatches

_RESET_CATEGORIES = {
    'transactions': {
        'label':  'Stock Transactions (godown + floor)',
        'tables': ['pm_godown_txn', 'pm_floor_txn'],
        'desc':   'All stock movement entries. Stock balances will reset to zero. Vouchers themselves are kept.'
    },
    'transfers': {
        'label':  'Material Transfers',
        'tables': ['pm_transfer_items', 'pm_transfer_edits', 'pm_transfers'],
        'desc':   'All Material OUT/IN vouchers and their line items + edit history.'
    },
    'mtvs': {
        'label':  'Legacy MTV Vouchers',
        'tables': ['pm_mtv_items', 'pm_mtv'],
        'desc':   'Legacy Material Transfer Vouchers (the old non-scan-based system) and their line items.'
    },
    'grns': {
        'label':  'GRN Vouchers',
        'tables': ['pm_grn_items', 'pm_grn'],
        'desc':   'All Goods Receipt Notes and their line items.'
    },
    'dns': {
        'label':  'Delivery Notes',
        'tables': ['pm_dn_items', 'pm_dn'],
        'desc':   'All outbound delivery notes to suppliers + line items.'
    },
    'boxes': {
        'label':  'Box Tracking',
        'tables': ['pm_box_movements', 'pm_boxes'],
        'desc':   'All physical box records with QR codes + their movement history. Use carefully — orphans GRN labels.'
    },
    'audit': {
        'label':  'Voucher Audit Trail',
        'tables': ['pm_voucher_audit'],
        'desc':   'All audit-log entries for voucher edits/deletes/creates.'
    },
    'products': {
        'label':  'Products (full wipe)',
        'tables': ['pm_products'],
        'desc':   'Removes all product master records. ⚠ Will fail if any GRN/transfer/DN still references a product — clear those categories first.'
    },
}

def _do_clear_categories(conn, cats):
    """Truncate each table in each requested category. Returns list of (cat, table, deleted_rows) tuples."""
    summary = []
    # Disable FK checks during a multi-table wipe so admin doesn't have to fight ordering
    try:
        conn.execute("SET FOREIGN_KEY_CHECKS=0")
    except Exception:
        pass
    try:
        for cat in cats:
            spec = _RESET_CATEGORIES.get(cat)
            if not spec:
                continue
            for tbl in spec['tables']:
                try:
                    cnt_row = conn.execute(f"SELECT COUNT(*) AS c FROM {tbl}").fetchone()
                    rows = int((cnt_row or {}).get('c', 0)) if isinstance(cnt_row, dict) else int(cnt_row['c'] if cnt_row else 0)
                except Exception:
                    rows = 0
                try:
                    conn.execute(f"DELETE FROM {tbl}")
                except Exception as e:
                    summary.append({'category': cat, 'table': tbl, 'deleted': 0, 'error': str(e)})
                    continue
                summary.append({'category': cat, 'table': tbl, 'deleted': rows})
    finally:
        try:
            conn.execute("SET FOREIGN_KEY_CHECKS=1")
        except Exception:
            pass
    return summary

def _table_exists(conn, table_name):
    try:
        conn.execute(f"SELECT 1 FROM {table_name} LIMIT 1")
        return True
    except:
        return False

def _parse_date_range(args):
    """Pull from/to from request args; default to last 30 days."""
    from datetime import date as _d, timedelta as _td
    today = _d.today()
    fromd = (args.get('from') or '').strip()
    tod   = (args.get('to')   or '').strip()
    try: f = _d.fromisoformat(fromd) if fromd else (today - _td(days=30))
    except Exception: f = today - _td(days=30)
    try: t = _d.fromisoformat(tod) if tod else today
    except Exception: t = today
    if f > t: f, t = t, f
    return f, t

