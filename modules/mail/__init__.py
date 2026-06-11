"""
mail package — Mail Master (CRM) module
=======================================
app.py usage (modules/ sys.path par hai, isliye short import):

    from mail import mail_bp
    app.register_blueprint(mail_bp)        # -> /mail/master
"""
from .mail_master_routes import mail_bp

__all__ = ['mail_bp']
