"""
models/npd.py
─────────────
NPD module ka schema model (single source of truth) — models/crm_lead.py
jaisa hi convention.

Old system (HCP-ERP) ke models/npd.py ka equivalent — bas yahan SQLAlchemy
classes ke bajaye table DDL + constants + model helpers hain, kyunki naya
system raw pymysql pe hai (no ORM).

  • Saare table/column names old models/npd.py ke EXACTLY same hain
    (data migration ke liye) — dekho migrations/npd_tables.sql
  • ensure_npd_tables(): app startup pe saari tables + seeds auto-create
  • Tables: npd_projects, milestone_masters (per-project), milestone_logs,
    npd_milestone_templates, npd_statuses, npd_activity_logs,
    office_dispatch_tokens, office_dispatch_items, client_dispatch
"""

try:
    from sampling_portal import get_db_connection as _db
except Exception:                       # package-context fallback
    from core.sampling_portal import get_db_connection as _db

# ── Constants (old system ke status/priority sets) ───────────────────────────
MS_STATUSES = [('pending', 'Pending', '#6b7280'),
               ('in_progress', 'In Progress', '#f59e0b'),
               ('approved', 'Approved', '#22c55e'),
               ('rejected', 'Rejected', '#ef4444'),
               ('skipped', 'Skipped', '#9ca3af')]
PRIORITIES = ['Urgent', 'High', 'Normal', 'Low']


def get_npd_statuses(conn):
    """Active NPD statuses (npd_statuses master) — name/slug/color."""
    return conn.execute(
        "SELECT name, slug, color FROM `npd_statuses` "
        "WHERE is_active=1 ORDER BY sort_order").fetchall() or []


# ─────────────────────────────────────────────────────────────────────────────
# TABLE BOOTSTRAP — OLD-SYSTEM-COMPATIBLE SCHEMA
# (Same as migrations/npd_tables.sql — app.py startup pe call hota hai)
# ─────────────────────────────────────────────────────────────────────────────
def ensure_npd_tables():
    conn = _db()
    if not conn:
        print("[npd] DB connection failed — tables skip.")
        return
    try:
        conn.execute("""CREATE TABLE IF NOT EXISTS `npd_projects` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            code VARCHAR(30) UNIQUE,
            project_type VARCHAR(20) NOT NULL DEFAULT 'npd',
            status VARCHAR(40) NOT NULL DEFAULT 'not_started',
            lead_id INT NULL,
            client_name VARCHAR(200) NULL, client_company VARCHAR(200) NULL,
            client_email VARCHAR(150) NULL, client_phone VARCHAR(20) NULL,
            product_name VARCHAR(300) NOT NULL,
            product_category VARCHAR(100) NULL, product_range VARCHAR(100) NULL,
            area_of_application VARCHAR(200) NULL, market_level VARCHAR(300) NULL,
            no_of_samples INT DEFAULT 0, moq VARCHAR(100) NULL,
            product_size VARCHAR(100) NULL, description TEXT NULL,
            ingredients TEXT NULL, active_ingredients VARCHAR(500) NULL,
            video_link VARCHAR(500) NULL, reference_brand VARCHAR(200) NULL,
            reference_product_name VARCHAR(300) NULL,
            variant_type VARCHAR(200) NULL, appearance VARCHAR(500) NULL,
            product_claim TEXT NULL, label_claim TEXT NULL,
            costing_range VARCHAR(200) NULL, ph_value VARCHAR(50) NULL,
            packaging_type VARCHAR(200) NULL, fragrance VARCHAR(200) NULL,
            viscosity VARCHAR(200) NULL,
            priority VARCHAR(50) DEFAULT 'Normal',
            project_start_date DATE NULL, project_lead_days INT NULL,
            project_end_date DATE NULL, client_coordinator VARCHAR(200) NULL,
            npd_fee_paid TINYINT(1) DEFAULT 0,
            npd_fee_amount DECIMAL(10,2) DEFAULT 10000,
            npd_fee_receipt VARCHAR(300) NULL, npd_fee_paid_at DATETIME NULL,
            reference_product VARCHAR(300) NULL,
            custom_formulation TINYINT(1) DEFAULT 0,
            requirement_spec TEXT NULL, order_quantity VARCHAR(100) NULL,
            assigned_members VARCHAR(500) NULL,
            assigned_rd_members VARCHAR(500) NULL,
            client_id INT NULL, assigned_sc INT NULL,
            assigned_rd INT NULL, npd_poc INT NULL,
            converted_to_commercial TINYINT(1) DEFAULT 0,
            commercial_converted_at DATETIME NULL,
            advance_paid TINYINT(1) DEFAULT 0,
            advance_amount DECIMAL(10,2) DEFAULT 2000,
            advance_receipt VARCHAR(300) NULL,
            milestone_master_created TINYINT(1) DEFAULT 0,
            target_sample_date DATE NULL, last_connected DATETIME NULL,
            delay_reason TEXT NULL, last_delay_update DATETIME NULL,
            cancel_reason TEXT NULL, cancelled_at DATETIME NULL,
            started_at DATETIME NULL, finished_at DATETIME NULL,
            total_duration_seconds INT NULL, completed_at DATETIME NULL,
            rd_param_defaults TEXT NULL, npd_milestone_data TEXT NULL,
            is_deleted TINYINT(1) NOT NULL DEFAULT 0,
            deleted_at DATETIME NULL, deleted_by INT NULL,
            created_by INT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_by INT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_npd_lead (lead_id), KEY idx_npd_client (client_id),
            KEY idx_npd_status (status), KEY idx_npd_type (project_type)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")

        conn.execute("""CREATE TABLE IF NOT EXISTS `milestone_masters` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            project_id INT NOT NULL,
            milestone_type VARCHAR(50) NOT NULL,
            title VARCHAR(200) NOT NULL, description TEXT NULL,
            is_selected TINYINT(1) DEFAULT 1,
            status VARCHAR(20) DEFAULT 'pending',
            sort_order INT DEFAULT 0,
            target_date DATE NULL, completed_at DATETIME NULL,
            assigned_to INT NULL, approved_by INT NULL,
            approved_at DATETIME NULL,
            attachments TEXT NULL, notes TEXT NULL, reject_reason TEXT NULL,
            created_by INT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP,
            KEY idx_mm_proj (project_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")

        conn.execute("""CREATE TABLE IF NOT EXISTS `milestone_logs` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            milestone_id INT NOT NULL,
            action VARCHAR(500) NOT NULL,
            old_status VARCHAR(20) NULL, new_status VARCHAR(20) NULL,
            note TEXT NULL, created_by INT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            KEY idx_ml_ms (milestone_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")

        conn.execute("""CREATE TABLE IF NOT EXISTS `npd_milestone_templates` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            milestone_type VARCHAR(50) NOT NULL UNIQUE,
            title VARCHAR(200) NOT NULL, description TEXT NULL,
            icon VARCHAR(10) DEFAULT '📌',
            applies_to VARCHAR(20) DEFAULT 'both',
            default_selected TINYINT(1) DEFAULT 1,
            is_mandatory TINYINT(1) DEFAULT 0,
            sort_order INT DEFAULT 0, is_active TINYINT(1) DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_by INT NULL, modified_at DATETIME NULL,
            modified_by INT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")

        conn.execute("""CREATE TABLE IF NOT EXISTS `npd_statuses` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            name VARCHAR(100) NOT NULL UNIQUE,
            slug VARCHAR(60) NOT NULL UNIQUE,
            color VARCHAR(20) DEFAULT '#6b7280',
            icon VARCHAR(10) DEFAULT '🔵',
            sort_order INT DEFAULT 0, is_active TINYINT(1) DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_by INT NULL, modified_by INT NULL, modified_at DATETIME NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")

        conn.execute("""CREATE TABLE IF NOT EXISTS `npd_activity_logs` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            project_id INT NOT NULL, user_id INT NULL,
            action VARCHAR(500) NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            KEY idx_nal_proj (project_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")

        conn.execute("""CREATE TABLE IF NOT EXISTS `office_dispatch_tokens` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            token_no VARCHAR(30) NOT NULL UNIQUE,
            dispatched_by INT NULL,
            dispatched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            notes TEXT NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")

        conn.execute("""CREATE TABLE IF NOT EXISTS `office_dispatch_items` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            token_id INT NOT NULL, project_id INT NOT NULL,
            sample_code VARCHAR(500) NULL,
            handover_to VARCHAR(200) NULL, submitted_by VARCHAR(200) NULL,
            rd_sub_assignment_id INT NULL,
            approval_status VARCHAR(20) NOT NULL DEFAULT 'pending',
            reject_reason TEXT NULL,
            actioned_by INT NULL, actioned_at DATETIME NULL,
            client_dispatch_id INT NULL, sent_to_client_at DATETIME NULL,
            KEY idx_odi_token (token_id), KEY idx_odi_proj (project_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")

        conn.execute("""CREATE TABLE IF NOT EXISTS `client_dispatch` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            token_no VARCHAR(50) NOT NULL,
            project_id INT NOT NULL,
            courier_name VARCHAR(100) NULL, tracking_no VARCHAR(150) NULL,
            extra_notes TEXT NULL,
            email_sent_to VARCHAR(200) NULL, email_sent_at DATETIME NULL,
            whatsapp_sent TINYINT(1) NOT NULL DEFAULT 0,
            dispatched_by INT NULL,
            dispatched_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            KEY idx_cd_proj (project_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")

        conn.execute("""CREATE TABLE IF NOT EXISTS `npd_comments` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            project_id INT NOT NULL,
            user_id INT NOT NULL,
            comment TEXT NOT NULL,
            is_internal TINYINT(1) DEFAULT 0,
            milestone_key VARCHAR(20) NULL,
            attachment VARCHAR(300) NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            edited_at DATETIME NULL,
            KEY idx_nc_proj (project_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")

        conn.execute("""CREATE TABLE IF NOT EXISTS `npd_boms` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            project_id INT NOT NULL,
            milestone_id INT NULL,
            product_name VARCHAR(255) NULL,
            code VARCHAR(100) NULL,
            variant VARCHAR(150) NULL,
            created_by INT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP,
            KEY ix_nb_proj (project_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")

        conn.execute("""CREATE TABLE IF NOT EXISTS `npd_bom_rows` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            bom_id INT NOT NULL,
            sr_no INT DEFAULT 1,
            inci_name VARCHAR(300) NULL,
            qty_pct DECIMAL(9,3) DEFAULT 0,
            KEY ix_nbr_bom (bom_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")

        conn.execute("""CREATE TABLE IF NOT EXISTS `npd_packing_rows` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            project_id INT NOT NULL,
            milestone_id INT NULL,
            category VARCHAR(50) DEFAULT 'Primary',
            vendor_name VARCHAR(200),
            cost DECIMAL(12,2) NULL,
            image_path VARCHAR(300),
            filling_image_path VARCHAR(300),
            coa_path VARCHAR(300),
            filling_status VARCHAR(30) DEFAULT 'pending',
            created_by INT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            INDEX idx_pack_proj (project_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")

        conn.execute("""CREATE TABLE IF NOT EXISTS `npd_personal_notes` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            project_id INT NOT NULL,
            user_id INT NOT NULL,
            note TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            KEY ix_npn_proj_user (project_id, user_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")

        conn.execute("""CREATE TABLE IF NOT EXISTS `npd_fda_requests` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            project_id INT NOT NULL,
            milestone_id INT NULL,
            to_emails TEXT NOT NULL,
            cc_emails TEXT NULL,
            subject VARCHAR(300) NOT NULL,
            body TEXT NOT NULL,
            attachments TEXT NULL,
            sent_by INT NULL,
            sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            KEY ix_nfr_proj (project_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")

        conn.execute("""CREATE TABLE IF NOT EXISTS `npd_fda_entries` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            project_id INT NOT NULL,
            milestone_id INT NULL,
            product_name VARCHAR(300) NOT NULL,
            free_sale_certificate VARCHAR(500) NULL,
            product_permission VARCHAR(500) NULL,
            msds VARCHAR(500) NULL,
            dossier VARCHAR(500) NULL,
            created_by INT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP,
            KEY ix_nfe_proj (project_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")

        conn.execute("""CREATE TABLE IF NOT EXISTS `npd_barcode_designs` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            project_id INT NOT NULL,
            milestone_id INT NULL,
            sr_no INT NOT NULL DEFAULT 1,
            design_path VARCHAR(500) NULL,
            barcode_path VARCHAR(500) NULL,
            design_width INT NULL, design_height INT NULL,
            created_by INT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP,
            KEY ix_nbd_proj (project_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")

        conn.execute("""CREATE TABLE IF NOT EXISTS `npd_comment_files` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            project_id INT NOT NULL,
            comment_id INT NOT NULL,
            file_name VARCHAR(255) NOT NULL,
            file_path VARCHAR(500) NOT NULL,
            file_size INT NULL,
            created_by INT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            KEY ix_ncf_comment (comment_id),
            KEY ix_ncf_project (project_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")

        conn.execute("""CREATE TABLE IF NOT EXISTS `npd_notes` (
            id INT AUTO_INCREMENT PRIMARY KEY,
            project_id INT NOT NULL UNIQUE,
            content TEXT NULL,
            updated_by INT NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""")

        # ── seeds (sirf khali table pe) ──────────────────────────────────
        if not conn.execute(
                "SELECT id FROM `npd_milestone_templates` LIMIT 1").fetchone():
            for mt, title, icon, so in [
                    ('bom', 'BOM', '📄', 1),
                    ('ingredients', 'Ingredients List & Marketing Sheet', '📋', 2),
                    ('quotation', 'Quotation', '💰', 3),
                    ('packing_material', 'Packing Material', '📦', 4),
                    ('artwork', 'Artwork / Design', '🎨', 5),
                    ('artwork_qc', 'Artwork QC Approval', '✅', 6),
                    ('fda', 'FDA', '🏛️', 7),
                    ('barcode', 'Barcode', '🔢', 8)]:
                conn.execute(
                    "INSERT INTO `npd_milestone_templates` "
                    "(milestone_type, title, icon, sort_order) "
                    "VALUES (%s,%s,%s,%s)", (mt, title, icon, so))

        if not conn.execute(
                "SELECT id FROM `npd_statuses` LIMIT 1").fetchone():
            # OLD SYSTEM ke production statuses (npd_statuses table se)
            for nm, sl, col, so in [
                    ('Not Started', 'not_started', '#6b7280', 1),
                    ('Sample Inprocess', 'sample_inprocess', '#8b5cf6', 2),
                    ('Sample Send to Client', 'sample_sent', '#06b6d4', 3),
                    ('On Hold', 'on_hold', '#f59e0b', 4),
                    ('Sample Rejected By Client', 'sample_rejected', '#ef4444', 5),
                    ('Sample Approved By Client', 'sample_approved', '#10b981', 6),
                    ('Cancelled', 'cancelled', '#dc2626', 7),
                    ('Finish', 'finish', '#22c55e', 8),
                    ('Sample Ready', 'sample_ready', '#3b82f6', 9),
                    ('Sent to Office', 'sent_to_office', '#6366f1', 10),
                    ('Rejected by Office', 'rejected_by_office', '#f97316', 11),
                    ('Approved By Office', 'approved_by_office', '#0ea5e9', 70)]:
                conn.execute(
                    "INSERT INTO `npd_statuses` (name, slug, color, sort_order) "
                    "VALUES (%s,%s,%s,%s)", (nm, sl, col, so))
        conn.commit()
        # discussion boards: artwork board support
        try:
            conn.execute("ALTER TABLE `npd_comments` "
                         "ADD COLUMN board VARCHAR(20) NULL")
            conn.commit()
        except Exception:
            pass

        print("[npd] tables ready (old-system compatible schema).")
    finally:
        conn.close()
