"""crm package — CRM · Lead module (HCPERP.zip integration).

Exposes the Flask blueprint and the table-bootstrap helper so app.py can do:

    from crm import crm_bp, ensure_lead_tables
    app.register_blueprint(crm_bp)
    ensure_lead_tables()
"""
from .crm_leads_routes import crm_bp, ensure_lead_tables
from . import crm_dashboard_routes  # noqa: F401  (CRM Dashboard — /crm/dashboard)

__all__ = ['crm_bp', 'ensure_lead_tables']
