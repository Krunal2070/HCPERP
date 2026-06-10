"""
═══════════════════════════════════════════════════════════════════════════════
INTEGRATION GUIDE — app.py changes required
═══════════════════════════════════════════════════════════════════════════════

STEP 1 ─ Register new Blueprints at the top of app.py
──────────────────────────────────────────────────────────────────────────────
Add these imports AFTER existing imports:

    from planning_routes import planning_bp
    from cash_routes     import cash_bp, init_cash_routes
    from qc_routes       import qc_bp

Then register them (put alongside existing blueprint registrations):

    app.register_blueprint(planning_bp)
    app.register_blueprint(cash_bp)
    app.register_blueprint(qc_bp)

    # Pass Excel path to cash_routes
    init_cash_routes(SERVER_PATH)


STEP 2 ─ Update ROLE_DEFAULT_PAGES in app.py
──────────────────────────────────────────────────────────────────────────────
Add 'planning' to admin and any planning-role dict:

    ROLE_DEFAULT_PAGES = {
        'admin':      {...existing..., 'planning', 'qc_dashboard'},
        'Purchase':   {...existing..., 'planning'},
        'Planning':   {'dashboard', 'planning'},       # NEW role (optional)
        'planning':   {'dashboard', 'planning'},       # NEW role (optional)
        ...
    }


STEP 3 ─ Update home() in app.py
──────────────────────────────────────────────────────────────────────────────
The new index.html is a KPI-card hub. Update the home() route to pass
two extra template variables:

    from datetime import datetime

    @app.route('/')
    @login_required
    def home():
        role = session.get('User_Type')

        # ── Role-based direct redirects (keep as-is) ──
        if role == "RD":
            return redirect(url_for('rd_sampling_page'))
        if (role or '').lower() == 'qc_common':
            return redirect(url_for('qc.qc_dashboard_page'))   # note: qc_bp prefix
        if _prod_role() == 'rm_store':
            return redirect(url_for('production_initiater_page'))
        if (role or '').lower() == 'production':
            return redirect(url_for('production_dept_page'))

        # ── New: all others see KPI card hub ──
        now = datetime.now()
        all_pages = _user_allowed_pages()
        _INDEX_SECTION_ORDER = ['transaction', 'loan', 'scrap']
        allowed_sections = [s for s in _INDEX_SECTION_ORDER if s in all_pages]

        return render_template(
            'index.html',
            role=role,
            user_name=session.get('User_Name'),
            allowed_sections=allowed_sections,
            now_hour=now.hour,
            today_str=now.strftime('%d %B %Y'),
        )


STEP 4 ─ Remove duplicate /qc_dashboard, /api/qc/* routes from app.py
──────────────────────────────────────────────────────────────────────────────
The following are now handled by qc_routes.py (qc_bp):
  - /qc_dashboard                        → qc_bp.qc_dashboard_page
  - /api/qc/status_map                   → qc_bp.api_qc_status_map
  - /api/qc/inprocess_checks             → qc_bp.api_qc_inprocess_checks
  - /api/qc/inprocess_check_save        → qc_bp.api_qc_inprocess_check_save
  - /api/qc/inprocess_unlock            → qc_bp.api_qc_inprocess_unlock
  - /api/qc_sampling/list               → qc_bp.api_qc_sampling_list
  - /api/qc_sampling/save               → qc_bp.api_qc_sampling_save

  Also remove _can_qc_dashboard() from app.py (it lives in qc_routes.py now).
  If prod_dept routes still need it, import from qc_routes:
      from qc_routes import _can_qc_dashboard

  Keep the /api/production_dept/summary_all route in app.py but change
  the _can_qc_dashboard() call to import from qc_routes.


STEP 5 ─ Remove /save and /delete_general from app.py (now in cash_routes.py)
──────────────────────────────────────────────────────────────────────────────
  - /save          → now at /cash/save     (cash_bp)
  - /delete_general → now at /cash/delete  (cash_bp)

  Also remove get_excel_instance(), get_transaction_data(), get_loan_data(),
  get_scrap_data() from app.py — they now live in cash_routes.py.

  The old home() route loaded Excel data for index.html tabs — remove that
  logic since the cash UI is now at /cash_management.


STEP 6 ─ Copy HTML files to templates/ folder
──────────────────────────────────────────────────────────────────────────────
  templates/
    index.html            ← new KPI card hub (replaces old index.html)
    cash_management.html  ← separate cash management page (NEW)
    planning_dashboard.html ← planning department page (NEW)
    qc_dashboard.html     ← unchanged (already exists)

STEP 7 ─ Update sidebar nav links in other pages
──────────────────────────────────────────────────────────────────────────────
  If other pages (canteen.html, production_department.html, etc.) have
  links pointing to /?section=transaction  →  update to /cash_management?section=transaction
  Links to /    →  keep as / (now shows KPI hub)


STEP 8 ─ ROLE_DEFAULT_PAGES — add 'planning'
──────────────────────────────────────────────────────────────────────────────
  'admin':    add 'planning'
  'Purchase': add 'planning'
  New optional role:
  'Planning': {'dashboard','planning'}


═══════════════════════════════════════════════════════════════════════════════
QUICK BLUEPRINT REGISTRATION SNIPPET (paste near top of app.py)
═══════════════════════════════════════════════════════════════════════════════
"""

# ─── Paste this near the existing blueprint registrations in app.py ───────────

REGISTRATION_SNIPPET = """
from planning_routes import planning_bp
from cash_routes     import cash_bp, init_cash_routes
from qc_routes       import qc_bp

app.register_blueprint(planning_bp)
app.register_blueprint(cash_bp)
app.register_blueprint(qc_bp)
init_cash_routes(SERVER_PATH)   # pass your Excel file path
"""

# ─── Updated home() route — paste over old home() in app.py ──────────────────

UPDATED_HOME = """
@app.route('/')
@login_required
def home():
    role = session.get('User_Type')

    # Role-based direct redirects (unchanged)
    if role == "RD":
        return redirect(url_for('rd_sampling_page'))
    if (role or '').lower() == 'qc_common':
        return redirect(url_for('qc.qc_dashboard_page'))
    if _prod_role() == 'rm_store':
        return redirect(url_for('production_initiater_page'))
    if (role or '').lower() == 'production':
        return redirect(url_for('production_dept_page'))

    # KPI card hub for all other roles
    now = datetime.now()
    all_pages = _user_allowed_pages()
    _INDEX_SECTION_ORDER = ['transaction', 'loan', 'scrap']
    allowed_sections = [s for s in _INDEX_SECTION_ORDER if s in all_pages]

    if not allowed_sections and role not in ('admin', 'Purchase', 'Planning', 'planning'):
        return "<h2>No permissions assigned</h2>"

    return render_template(
        'index.html',
        role=role,
        user_name=session.get('User_Name'),
        allowed_sections=allowed_sections,
        now_hour=now.hour,
        today_str=now.strftime('%d %B %Y'),
    )
"""

if __name__ == '__main__':
    print(__doc__)
    print("REGISTRATION SNIPPET:")
    print(REGISTRATION_SNIPPET)
    print("\nUPDATED HOME():")
    print(UPDATED_HOME)
