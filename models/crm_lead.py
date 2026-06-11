"""
models/crm_lead.py
──────────────────
CRM module ka schema model (single source of truth).

NOTE:
  - CRM ke routes (modules/crm/crm_leads_routes.py) abhi RAW pymysql use karte
    hain (SQLAlchemy ORM nahi). Ye file schema ka reference + column-metadata
    deta hai taaki fields ek hi jagah defined rahein aur code mashup na ho.
  - SQLAlchemy classes bhi diye hain (source app ke style me) — ORM chahiye to
    ready hain. `extend_existing=True` lagaya hai taaki agar `leads` table kahin
    aur (models/lead.py) bhi define ho to conflict na aaye.

Tables: leads, lead_discussions, lead_attachments, lead_reminders, lead_notes,
        lead_activity_logs, lead_contributions, contribution_config,
        client_masters, client_brands, client_addresses,
        lead_statuses, lead_sources, lead_categories, product_ranges
"""

from datetime import datetime

try:
    from .base import db          # source app ka shared SQLAlchemy instance
    _HAS_DB = True
except Exception:                  # base.py na mile to schema-only mode
    db = None
    _HAS_DB = False


# ═══════════════════════════════════════════════════════════════════════════
#  COLUMN METADATA  →  list page / Columns dropdown isi se chalta hai
#  (col_key, label, default_visible)
# ═══════════════════════════════════════════════════════════════════════════
LEAD_LIST_COLUMNS = [
    ('created',        'Created',        True),
    ('name',           'Name',           True),
    ('company',        'Company',        True),
    ('email',          'Email',          True),
    ('mobile',         'Mobile',         True),
    ('product',        'Product',        True),
    ('team',           'Team',           True),
    ('status',         'Status',         True),
    ('lead_type',      'Lead Type',      True),
    ('last_contact',   'Last Contact',   True),
    ('age',            'Days (Age)',     True),
    ('code',           'Code',           False),
    ('position',       'Position',       False),
    ('website',        'Website',        False),
    ('alt_mobile',     'Alt. Mobile',    False),
    ('source',         'Source',         False),
    ('category',       'Category',       False),
    ('product_range',  'Product Range',  False),
    ('order_quantity', 'Order Qty',      False),
    ('city',           'City',           False),
    ('state',          'State',          False),
    ('country',        'Country',        False),
    ('zip_code',       'ZIP',            False),
    ('avg_cost',       'Avg Cost',       False),
    ('tags',           'Tags',           False),
]

# Saari leads columns (DB) — type reference ke liye
LEAD_FIELDS = [
    ('id', 'int'), ('code', 'str'), ('title', 'str'), ('contact_name', 'str'),
    ('company_name', 'str'), ('email', 'str'), ('website', 'str'), ('phone', 'str'),
    ('alternate_mobile', 'str'), ('source', 'str'), ('status', 'str'),
    ('lead_type', 'str'), ('priority', 'str'), ('expected_value', 'decimal'),
    ('average_cost', 'decimal'), ('assigned_to', 'int'), ('follow_up_date', 'date'),
    ('notes', 'text'), ('lost_reason', 'str'), ('customer_id', 'int'),
    ('position', 'str'), ('address', 'text'), ('city', 'str'), ('state', 'str'),
    ('country', 'str'), ('zip_code', 'str'), ('product_name', 'str'),
    ('category', 'str'), ('product_range', 'str'), ('order_quantity', 'str'),
    ('requirement_spec', 'text'), ('tags', 'str'), ('remark', 'text'),
    ('last_contact', 'datetime'), ('team_members', 'text'), ('client_id', 'int'),
    ('client_attachment', 'str'), ('is_deleted', 'bool'), ('deleted_at', 'datetime'),
    ('closed_at', 'datetime'), ('created_by', 'int'), ('created_at', 'datetime'),
    ('modified_by', 'int'), ('updated_at', 'datetime'),
]

CLIENT_FIELDS = [
    ('id', 'int'), ('code', 'str'), ('company_name', 'str'), ('contact_name', 'str'),
    ('position', 'str'), ('email', 'str'), ('website', 'str'), ('mobile', 'str'),
    ('alternate_mobile', 'str'), ('gstin', 'str'), ('status', 'str'),
    ('address', 'text'), ('city', 'str'), ('state', 'str'), ('country', 'str'),
    ('zip_code', 'str'), ('notes', 'text'), ('is_deleted', 'bool'),
    ('deleted_at', 'datetime'), ('created_by', 'int'), ('created_at', 'datetime'),
    ('modified_by', 'int'), ('updated_at', 'datetime'),
]


# ═══════════════════════════════════════════════════════════════════════════
#  SQLAlchemy MODELS  (sirf tab define honge jab base.db mile)
# ═══════════════════════════════════════════════════════════════════════════
if _HAS_DB:

    _SAFE = {'extend_existing': True}

    class Lead(db.Model):
        __tablename__ = 'leads'
        __table_args__ = _SAFE
        id = db.Column(db.Integer, primary_key=True)
        code = db.Column(db.String(30), unique=True)
        title = db.Column(db.String(200))
        contact_name = db.Column(db.String(150), nullable=False)
        company_name = db.Column(db.String(200))
        email = db.Column(db.String(150))
        website = db.Column(db.String(200))
        phone = db.Column(db.String(20))
        alternate_mobile = db.Column(db.String(20))
        source = db.Column(db.String(100))
        status = db.Column(db.String(30), default='open')
        lead_type = db.Column(db.String(20), default='Quality')
        priority = db.Column(db.String(20), default='medium')
        expected_value = db.Column(db.Numeric(12, 2))
        average_cost = db.Column(db.Numeric(12, 2), default=0)
        assigned_to = db.Column(db.Integer)
        follow_up_date = db.Column(db.Date)
        notes = db.Column(db.Text)
        lost_reason = db.Column(db.String(200))
        customer_id = db.Column(db.Integer)
        position = db.Column(db.String(100))
        address = db.Column(db.Text)
        city = db.Column(db.String(100))
        state = db.Column(db.String(100))
        country = db.Column(db.String(100), default='India')
        zip_code = db.Column(db.String(10))
        product_name = db.Column(db.String(200))
        category = db.Column(db.String(100))
        product_range = db.Column(db.String(100))
        order_quantity = db.Column(db.String(100))
        requirement_spec = db.Column(db.Text)
        tags = db.Column(db.String(300))
        remark = db.Column(db.Text)
        last_contact = db.Column(db.DateTime)
        team_members = db.Column(db.Text)
        client_id = db.Column(db.Integer)
        client_attachment = db.Column(db.String(300))
        is_deleted = db.Column(db.Boolean, default=False)
        deleted_at = db.Column(db.DateTime)
        closed_at = db.Column(db.DateTime)
        created_by = db.Column(db.Integer)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        modified_by = db.Column(db.Integer)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow,
                               onupdate=datetime.utcnow)

    class LeadDiscussion(db.Model):
        __tablename__ = 'lead_discussions'
        __table_args__ = _SAFE
        id = db.Column(db.Integer, primary_key=True)
        lead_id = db.Column(db.Integer, nullable=False, index=True)
        user_id = db.Column(db.Integer, nullable=False)
        comment = db.Column(db.Text, nullable=False)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)

    class LeadAttachment(db.Model):
        __tablename__ = 'lead_attachments'
        __table_args__ = _SAFE
        id = db.Column(db.Integer, primary_key=True)
        lead_id = db.Column(db.Integer, nullable=False, index=True)
        discussion_id = db.Column(db.Integer, index=True)
        file_name = db.Column(db.String(300), nullable=False)
        file_path = db.Column(db.String(500), nullable=False)
        file_size = db.Column(db.Integer)
        file_type = db.Column(db.String(100))
        uploaded_by = db.Column(db.Integer)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)

    class LeadReminder(db.Model):
        __tablename__ = 'lead_reminders'
        __table_args__ = _SAFE
        id = db.Column(db.Integer, primary_key=True)
        lead_id = db.Column(db.Integer, nullable=False, index=True)
        user_id = db.Column(db.Integer, nullable=False)
        title = db.Column(db.String(300), nullable=False)
        description = db.Column(db.Text)
        remind_at = db.Column(db.DateTime, nullable=False)
        is_done = db.Column(db.Boolean, default=False)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)

    class LeadNote(db.Model):
        __tablename__ = 'lead_notes'
        __table_args__ = _SAFE
        id = db.Column(db.Integer, primary_key=True)
        lead_id = db.Column(db.Integer, nullable=False, index=True)
        user_id = db.Column(db.Integer, nullable=False)
        note = db.Column(db.Text, nullable=False)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow,
                               onupdate=datetime.utcnow)

    class LeadActivityLog(db.Model):
        __tablename__ = 'lead_activity_logs'
        __table_args__ = _SAFE
        id = db.Column(db.Integer, primary_key=True)
        lead_id = db.Column(db.Integer, nullable=False, index=True)
        user_id = db.Column(db.Integer)
        action = db.Column(db.String(500), nullable=False)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)

    class LeadContribution(db.Model):
        __tablename__ = 'lead_contributions'
        __table_args__ = _SAFE
        id = db.Column(db.Integer, primary_key=True)
        lead_id = db.Column(db.Integer, nullable=False, index=True)
        user_id = db.Column(db.Integer, nullable=False)
        action_type = db.Column(db.String(30), nullable=False)
        points = db.Column(db.Integer, default=0)
        note = db.Column(db.String(200))
        created_at = db.Column(db.DateTime, default=datetime.utcnow)

    class ContributionConfig(db.Model):
        __tablename__ = 'contribution_config'
        __table_args__ = _SAFE
        id = db.Column(db.Integer, primary_key=True)
        action_type = db.Column(db.String(30), nullable=False, unique=True)
        label = db.Column(db.String(100), nullable=False)
        points = db.Column(db.Integer, default=0)
        description = db.Column(db.String(200))
        updated_by = db.Column(db.Integer)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow,
                               onupdate=datetime.utcnow)

    # ── Client Master ──
    class ClientMaster(db.Model):
        __tablename__ = 'client_masters'
        __table_args__ = _SAFE
        id = db.Column(db.Integer, primary_key=True)
        code = db.Column(db.String(20), unique=True)
        company_name = db.Column(db.String(200))
        contact_name = db.Column(db.String(150), nullable=False)
        position = db.Column(db.String(100))
        email = db.Column(db.String(150))
        website = db.Column(db.String(200))
        mobile = db.Column(db.String(20))
        alternate_mobile = db.Column(db.String(20))
        gstin = db.Column(db.String(20))
        status = db.Column(db.String(20), default='active')
        address = db.Column(db.Text)
        city = db.Column(db.String(100))
        state = db.Column(db.String(100))
        country = db.Column(db.String(100), default='India')
        zip_code = db.Column(db.String(10))
        notes = db.Column(db.Text)
        is_deleted = db.Column(db.Boolean, default=False)
        deleted_at = db.Column(db.DateTime)
        created_by = db.Column(db.Integer)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)
        modified_by = db.Column(db.Integer)
        updated_at = db.Column(db.DateTime, default=datetime.utcnow,
                               onupdate=datetime.utcnow)

    class ClientBrand(db.Model):
        __tablename__ = 'client_brands'
        __table_args__ = _SAFE
        id = db.Column(db.Integer, primary_key=True)
        client_id = db.Column(db.Integer, nullable=False, index=True)
        brand_name = db.Column(db.String(200), nullable=False)
        category = db.Column(db.String(100))
        description = db.Column(db.Text)
        is_active = db.Column(db.Boolean, default=True)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)

    class ClientAddress(db.Model):
        __tablename__ = 'client_addresses'
        __table_args__ = _SAFE
        id = db.Column(db.Integer, primary_key=True)
        client_id = db.Column(db.Integer, nullable=False, index=True)
        brand_index = db.Column(db.Integer, default=0)
        title = db.Column(db.String(100), nullable=False, default='Address')
        addr_type = db.Column(db.String(20), default='billing')
        address = db.Column(db.Text)
        city = db.Column(db.String(100))
        state = db.Column(db.String(100))
        country = db.Column(db.String(100), default='India')
        zip_code = db.Column(db.String(10))
        is_default = db.Column(db.Boolean, default=False)
        created_at = db.Column(db.DateTime, default=datetime.utcnow)

    # ── Masters ──
    class LeadStatus(db.Model):
        __tablename__ = 'lead_statuses'
        __table_args__ = _SAFE
        id = db.Column(db.Integer, primary_key=True)
        name = db.Column(db.String(30), nullable=False, unique=True)
        label = db.Column(db.String(60), nullable=False)
        color = db.Column(db.String(20), default='#64748b')
        icon = db.Column(db.String(40))
        sort_order = db.Column(db.Integer, default=0)
        is_active = db.Column(db.Boolean, default=True)

    class LeadSource(db.Model):
        __tablename__ = 'lead_sources'
        __table_args__ = _SAFE
        id = db.Column(db.Integer, primary_key=True)
        name = db.Column(db.String(100), nullable=False, unique=True)
        sort_order = db.Column(db.Integer, default=0)
        is_active = db.Column(db.Boolean, default=True)

    class LeadCategory(db.Model):
        __tablename__ = 'lead_categories'
        __table_args__ = _SAFE
        id = db.Column(db.Integer, primary_key=True)
        name = db.Column(db.String(100), nullable=False, unique=True)
        sort_order = db.Column(db.Integer, default=0)
        is_active = db.Column(db.Boolean, default=True)

    class ProductRange(db.Model):
        __tablename__ = 'product_ranges'
        __table_args__ = _SAFE
        id = db.Column(db.Integer, primary_key=True)
        name = db.Column(db.String(100), nullable=False, unique=True)
        sort_order = db.Column(db.Integer, default=0)
        is_active = db.Column(db.Boolean, default=True)
