"""
mail/mail_master_routes.py — Mail Master (CRM)
==============================================
Blueprint : mail  at  /mail
DB        : Raw pymysql via sampling_portal (NO SQLAlchemy) — CRM module jaisa hi.

NOTE: core/ aur modules/ app.py ke path-bootstrap se sys.path par aa jaate hain,
      isliye `import sampling_portal` / `from menus import get_menu` short hi rehte hain
      (crm module jaisa hi).

Routes:
  GET  /mail/master              — List all email templates (cards)
  GET  /mail/master/<code>/edit  — Edit form (WYSIWYG)
  POST /mail/master/<code>/edit  — Save template
"""
from functools import wraps
from datetime import datetime

from flask import (Blueprint, render_template, request, redirect,
                   url_for, flash, session)

import sampling_portal  # same pymysql bridge as CRM module (core/ on sys.path)

try:
    from menus import get_menu
except Exception:
    def get_menu(*a, **k):
        return None

mail_bp = Blueprint('mail', __name__, url_prefix='/mail')


# ─────────────────────────────────────────────
# Helpers (CRM module ke same pattern)
# ─────────────────────────────────────────────
def _db():
    return sampling_portal.get_db_connection()


def _uname():
    return session.get('User_Name') or session.get('UID') or 'User'


def _role():
    return (session.get('User_Type') or session.get('role') or '').lower()


def _is_admin():
    return _role() == 'admin' or (session.get('UID', '') or '').lower() == 'admin'


def login_required(f):
    @wraps(f)
    def wrapper(*a, **k):
        if not session.get('logged_in'):
            return redirect(url_for('login'))
        return f(*a, **k)
    return wrapper


# ─────────────────────────────────────────────
# Default templates (pehli baar seed)
# ─────────────────────────────────────────────
_DEFAULTS = [
    {
        'code': 'npd_project',
        'name': 'NPD Project Email',
        'subject': '{company} - Request for proposal (RFP) for Skincare products',
        'body': ('<p>Dear {client_name},</p>\n'
                 '<p>Greetings from HCP Wellness!</p>\n'
                 '<p>We are pleased to share our proposal for <b>{product}</b>. '
                 'Kindly review and let us know your feedback.</p>\n'
                 '<p>Regards,<br>HCP Wellness Pvt. Ltd.</p>'),
    },
    {
        'code': 'quotation',
        'name': 'Quotation Email',
        'subject': 'Final Quote for {company} - {quot_number}',
        'body': ('<p>Dear {client_name},</p>\n'
                 '<p>Please find attached the quotation for <b>{product}</b>.</p>\n'
                 '<p>For any clarification feel free to reach out.</p>\n'
                 '<p>Regards,<br>HCP Wellness Pvt. Ltd.</p>'),
    },
    {
        'code': 'sample_dispatch',
        'name': 'Sample Dispatch Email',
        'subject': 'Sample Dispatch Details \u2013 {project_code}',
        'body': ('<p>Dear {client_name},</p>\n'
                 '<p>We have dispatched the samples for your project. '
                 'Please find the tracking details in this mail.</p>\n'
                 '<p>Kindly acknowledge on receipt.</p>\n'
                 '<p>Regards,<br>HCP Wellness Pvt. Ltd.</p>'),
    },
    {
        'code': 'sample_order',
        'name': 'Sample Order Confirmation Email',
        'subject': '{company} - Sample Order #{order_number}',
        'body': ('<p>Dear {client_name},</p>\n'
                 '<p>Your sample order has been confirmed. Details are mentioned below.</p>\n'
                 '<p>Regards,<br>HCP Wellness Pvt. Ltd.</p>'),
    },
]


def _ensure_table(conn):
    """email_templates table + default rows (idempotent)."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS `email_templates` ("
        "  `id`         INT NOT NULL AUTO_INCREMENT,"
        "  `code`       VARCHAR(50)  NOT NULL,"
        "  `name`       VARCHAR(200) NOT NULL,"
        "  `subject`    VARCHAR(500) NOT NULL,"
        "  `body`       TEXT NOT NULL,"
        "  `from_email` VARCHAR(150) DEFAULT 'info@hcpwellness.in',"
        "  `from_name`  VARCHAR(150) DEFAULT 'HCP Wellness Pvt. Ltd.',"
        "  `is_active`  TINYINT(1) DEFAULT 1,"
        "  `updated_by` INT DEFAULT NULL,"
        "  `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP,"
        "  `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,"
        "  PRIMARY KEY (`id`),"
        "  UNIQUE KEY `uq_email_templates_code` (`code`)"
        ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    )
    conn.commit()
    for d in _DEFAULTS:
        ex = conn.execute(
            "SELECT id FROM `email_templates` WHERE code=%s", (d['code'],)
        ).fetchone()
        if not ex:
            conn.execute(
                "INSERT INTO `email_templates` (code, name, subject, body) "
                "VALUES (%s, %s, %s, %s)",
                (d['code'], d['name'], d['subject'], d['body']))
    conn.commit()


# ─────────────────────────────────────────────
# Routes
# ─────────────────────────────────────────────
@mail_bp.route('/master')
@login_required
def mail_master():
    if not _is_admin():
        flash('Access denied: Mail Master sirf admin ke liye hai.', 'error')
        return redirect('/')
    conn = _db()
    try:
        _ensure_table(conn)
        templates = conn.execute(
            "SELECT * FROM `email_templates` ORDER BY name").fetchall() or []
    finally:
        conn.close()
    return render_template(
        'mail/master.html',
        templates=templates,
        sidebar_menu=get_menu('crm', role=_role(), is_admin=_is_admin()),
        active_item='mail-master', user_name=_uname(),
        role=session.get('User_Type'), is_admin=_is_admin())


@mail_bp.route('/master/<code>/edit', methods=['GET', 'POST'])
@login_required
def mail_template_edit(code):
    if not _is_admin():
        flash('Access denied: Mail Master sirf admin ke liye hai.', 'error')
        return redirect('/')
    conn = _db()
    try:
        _ensure_table(conn)
        if request.method == 'POST':
            conn.execute(
                "UPDATE `email_templates` SET name=%s, subject=%s, body=%s, "
                "from_email=%s, from_name=%s, is_active=%s, updated_at=%s "
                "WHERE code=%s",
                (request.form.get('name', '').strip(),
                 request.form.get('subject', '').strip(),
                 request.form.get('body', ''),
                 request.form.get('from_email', 'info@hcpwellness.in').strip(),
                 request.form.get('from_name', 'HCP Wellness Pvt. Ltd.').strip(),
                 1 if request.form.get('is_active') == '1' else 0,
                 datetime.utcnow(), code))
            conn.commit()
            flash('\u2705 Template save ho gaya!', 'success')
            return redirect(url_for('mail.mail_master'))

        t = conn.execute(
            "SELECT * FROM `email_templates` WHERE code=%s", (code,)).fetchone()
    finally:
        conn.close()

    if not t:
        flash('Template nahi mila.', 'error')
        return redirect(url_for('mail.mail_master'))

    return render_template(
        'mail/template_edit.html', t=t,
        sidebar_menu=get_menu('crm', role=_role(), is_admin=_is_admin()),
        active_item='mail-master', user_name=_uname(),
        role=session.get('User_Type'), is_admin=_is_admin())
