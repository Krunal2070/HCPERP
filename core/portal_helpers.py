# ══════════════════════════════════════════════════════════════════════════════
# portal_helpers.py
# Shared permission helpers used by both app.py and blueprint modules.
# Import from here instead of from app.py to avoid circular imports.
# ══════════════════════════════════════════════════════════════════════════════

from flask import session
import sampling_portal

# ── PAGE ACCESS DEFAULTS PER ROLE ────────────────────────────────────────────
ROLE_DEFAULT_PAGES = {
    'admin':      {
                   'dashboard','rd_sampling','qc_sampling','qc_dashboard',
                   'task_reminders','task_scheduler','manage_users',
                   'access_control','transaction','loan','scrap',
                   'production_initiater','cms','procurement','production_dept',
                   'planning','backup','trs_view','packing','crm',
                  },
    'Purchase':   {'dashboard','rd_sampling','qc_sampling','qc_dashboard',
                   'transaction','loan','scrap','cms',
                   'task_reminders','trs_view'},
    'RD':         {'dashboard','rd_sampling','task_reminders','trs_view'},
    'QC':         {'dashboard','qc_sampling','qc_dashboard','task_reminders','trs_view','packing'},
    'Planning':   {'dashboard','planning','task_reminders'},
    'Production': {'dashboard','production_dept','task_reminders'},
    'Stores':     {'dashboard','production_initiater','task_reminders'},
    'stores':     {'dashboard','production_initiater','task_reminders'},
    'Packing':    {'dashboard','packing'},
    'qc_common':  {'dashboard','qc_sampling','qc_dashboard','task_reminders','trs_view','packing'},
    'QC_Common':  {'dashboard','qc_sampling','qc_dashboard','task_reminders','trs_view','packing'},
    'User':       {'dashboard','transaction','loan','scrap'},
    'RM_Store':   {'dashboard','production_initiater','task_reminders'},
    'rm_store':   {'dashboard','production_initiater','task_reminders'},
    'Rm_Store':   {'dashboard','production_initiater','task_reminders'},
}

# ── Per-user page overrides (hardcoded grants) ────────────────────────────────
_USER_PAGE_GRANTS = {
    'dharmendra': {'transaction', 'loan', 'scrap'},
}


def _get_all_permissions():
    """
    Returns a set of all permission keys the current user has.
    Covers both page: keys and feature keys (txn_add, rd_view etc.)
    Admin always gets everything. All others start from ROLE_DEFAULT_PAGES
    then DB overrides are applied.
    """
    role    = session.get('User_Type', '')
    user_id = session.get('user_id')
    uid     = (session.get('UID') or '').lower()

    if role == 'admin':
        all_keys = set(ROLE_DEFAULT_PAGES['admin'])
        _ADMIN_FEATURE_KEYS = {
            'txn_view','txn_add','txn_edit','txn_delete','txn_export',
            'loan_view','loan_add','loan_edit','loan_delete',
            'scrap_view','scrap_add','scrap_edit','scrap_delete',
            'rd_view','rd_add','rd_edit','rd_print','rd_approve',
            'qc_view','qc_add','qc_edit','qc_print','qc_reports',
            'sch_view','sch_own_add','sch_all_add','sch_edit','sch_delete',
            'usr_view','usr_create','usr_edit','usr_deactivate','usr_reset','usr_access',
            'prod_view','prod_add','prod_print_sheets','prod_print_labels','prod_delete',
            'pck_view','pck_add','pck_edit','pck_delete','pck_export',
        }
        return all_keys | _ADMIN_FEATURE_KEYS

    perms = set(ROLE_DEFAULT_PAGES.get(role, {'dashboard'}))

    if uid in _USER_PAGE_GRANTS:
        perms |= _USER_PAGE_GRANTS[uid]

    if user_id:
        try:
            overrides = sampling_portal.get_user_permissions(user_id)
            for key, allowed in overrides.items():
                if key.startswith('page:'):
                    pg = key[5:]
                    if allowed:
                        perms.add(pg)
                        perms.add(key)
                    else:
                        perms.discard(pg)
                        perms.discard(key)
                else:
                    if allowed:
                        perms.add(key)
                    else:
                        perms.discard(key)
        except Exception:
            pass
    return perms


def _user_allowed_pages():
    """Returns set of page keys (without page: prefix) the current user may access."""
    perms = _get_all_permissions()
    pages = set()
    for k in perms:
        if k.startswith('page:'):
            pages.add(k[5:])
        else:
            pages.add(k)
    return pages


def can_access(page_key: str) -> bool:
    """True if current user may open this page."""
    return bool(session.get('logged_in')) and page_key in _user_allowed_pages()


def can_do(feature_key: str) -> bool:
    """True if current user has a specific feature permission."""
    if not session.get('logged_in'):
        return False
    return feature_key in _get_all_permissions()


def _denied(label='this page'):
    return (
        f"""<!DOCTYPE html><html><head><title>Access Denied</title>
<style>body{{font-family:sans-serif;background:#f8fafc;display:flex;
align-items:center;justify-content:center;min-height:100vh;margin:0}}
.box{{background:#fff;border-radius:16px;padding:56px 48px;text-align:center;
box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:400px}}
.ico{{font-size:56px;margin-bottom:12px}} h2{{color:#dc2626;margin:0 0 8px}}
p{{color:#64748b;margin:4px 0}} a{{color:#0d9488;font-weight:600;text-decoration:none}}
</style></head><body><div class="box">
<div class="ico">&#128274;</div>
<h2>Access Denied</h2>
<p>You don't have permission to access</p>
<p><strong>{label}</strong></p>
<br><a href="/">&#8592; Back to Portal</a>
</div></body></html>""",
        403
    )


def _prod_role():
    """Return 'admin', 'rm_store', or None.
    Checks (in order):
      1. user_type == 'admin'
      2. user_type matches rm_store (any capitalisation)
      3. department field contains 'rm' or 'store' or 'production'
         (skipped if user_type is 'Production' — that role has its own page)
      4. user_permissions table has prod_view
    """
    if not session.get('logged_in'):
        return None
    r = session.get('User_Type', '') or ''
    if r.lower() == 'admin':
        return 'admin'
    if r.lower() in ('rm_store', 'rm store', 'rmstore', 'rm-store', 'stores', 'store'):
        return 'rm_store'

    if r.lower() == 'production':
        return None

    dept = (session.get('department') or '').lower()
    if any(kw in dept for kw in ('rm_store', 'rm store', 'rmstore', 'production')):
        return 'rm_store'

    user_id = session.get('user_id')
    if user_id:
        try:
            perms = sampling_portal.get_user_permissions(user_id) or {}
            if perms.get('prod_view'):
                if perms.get('prod_add') or perms.get('prod_print_sheets') or perms.get('prod_delete'):
                    return 'admin'
                return 'rm_store'
        except Exception:
            pass
    return None
