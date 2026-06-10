## HOW TO APPLY THIS PATCH
## ─────────────────────────────────────────────────────────────────
## STEP 1: Open app.py, find this line near the top (around line 29):
##
##     import sampling_portal
##
## Add this line directly below it:
##
##     import cms_portal
##     cms_portal.cms_v3_init_db()
##
## ─────────────────────────────────────────────────────────────────
## STEP 2: Find this line in app.py (around line 6191):
##
##     # ── END CMS ROUTES ──────────────...
##
## Paste ALL the code below (everything after the dashes) just BEFORE that line.
## ─────────────────────────────────────────────────────────────────


# ── CMS v3: LEDGER GROUPS ────────────────────────────────────────────────────

@app.route('/api/cms/ledger_groups')
@login_required
def api_cms_ledger_groups():
    return jsonify(cms_portal.cms_get_ledger_groups())

@app.route('/api/cms/ledger_groups/save', methods=['POST'])
@login_required
def api_cms_ledger_group_save():
    d = request.get_json()
    return jsonify(cms_portal.cms_save_ledger_group(d))

@app.route('/api/cms/ledger_groups/delete', methods=['POST'])
@login_required
def api_cms_ledger_group_delete():
    d = request.get_json()
    return jsonify(cms_portal.cms_delete_ledger_group(d['id']))


# ── CMS v3: LEDGERS ──────────────────────────────────────────────────────────

@app.route('/api/cms/ledgers')
@login_required
def api_cms_ledgers():
    return jsonify(cms_portal.cms_get_ledgers(
        ledger_type=request.args.get('type', ''),
        group_id=request.args.get('group_id'),
        search=request.args.get('q', '')
    ))

@app.route('/api/cms/ledgers/save', methods=['POST'])
@login_required
def api_cms_ledger_save():
    return jsonify(cms_portal.cms_save_ledger(request.get_json()))

@app.route('/api/cms/ledgers/delete', methods=['POST'])
@login_required
def api_cms_ledger_delete():
    d = request.get_json()
    return jsonify(cms_portal.cms_delete_ledger(d['id']))

@app.route('/api/cms/ledgers/<int:lid>/report')
@login_required
def api_cms_ledger_report(lid):
    return jsonify(cms_portal.cms_ledger_report(
        lid,
        from_date=request.args.get('from', ''),
        to_date=request.args.get('to', '')
    ))

@app.route('/api/cms/ledgers/<int:lid>/advances')
@login_required
def api_cms_ledger_advances(lid):
    return jsonify(cms_portal.cms_get_pending_advances(lid))


# ── CMS v3: VOUCHERS ─────────────────────────────────────────────────────────

@app.route('/api/cms/vouchers')
@login_required
def api_cms_vouchers():
    return jsonify(cms_portal.cms_get_vouchers(
        from_date=request.args.get('from', ''),
        to_date=request.args.get('to', ''),
        vtype=request.args.get('type', ''),
        ledger_id=request.args.get('ledger_id'),
        page=int(request.args.get('page', 1)),
        per_page=int(request.args.get('per_page', 25))
    ))

@app.route('/api/cms/vouchers/<int:vid>')
@login_required
def api_cms_voucher_get(vid):
    v = cms_portal.cms_get_voucher(vid)
    if not v:
        return jsonify({'error': 'not found'}), 404
    return jsonify(v)

@app.route('/api/cms/vouchers/save', methods=['POST'])
@login_required
def api_cms_voucher_save():
    data = request.get_json()
    data['created_by'] = session.get('UID', '')
    return jsonify(cms_portal.cms_save_voucher(data))

@app.route('/api/cms/vouchers/delete', methods=['POST'])
@login_required
def api_cms_voucher_delete():
    d = request.get_json()
    return jsonify(cms_portal.cms_delete_voucher(d['id']))


# ── CMS v3: DASHBOARD (replaces old cms_dashboard route) ─────────────────────
# NOTE: the old route @app.route('/api/cms/dashboard') at line ~5678 still
# points to sampling_portal.cms_get_dashboard — Flask will use the LAST
# registered route for duplicate paths, so this one wins.

@app.route('/api/cms/v3/dashboard')
@login_required
def api_cms_v3_dashboard():
    return jsonify(cms_portal.cms_dashboard(
        from_date=request.args.get('from', ''),
        to_date=request.args.get('to', '')
    ))


# ── CMS v3: REPORTS ──────────────────────────────────────────────────────────

@app.route('/api/cms/report/advances')
@login_required
def api_cms_advances():
    return jsonify(cms_portal.cms_advance_report())

@app.route('/api/cms/report/receivables')
@login_required
def api_cms_receivables_v3():
    return jsonify(cms_portal.cms_receivables())

@app.route('/api/cms/report/payables')
@login_required
def api_cms_payables_v3():
    return jsonify(cms_portal.cms_payables())

@app.route('/api/cms/v3/report/daily')
@login_required
def api_cms_v3_daily():
    from datetime import date
    dt = request.args.get('date', date.today().isoformat())
    return jsonify(cms_portal.cms_daily_report(dt))

@app.route('/api/cms/v3/report/category')
@login_required
def api_cms_v3_category():
    return jsonify(cms_portal.cms_category_report(
        from_date=request.args.get('from', ''),
        to_date=request.args.get('to', ''),
        nature=request.args.get('nature', 'expense')
    ))


# ── CMS v3: REMINDERS ────────────────────────────────────────────────────────

@app.route('/api/cms/reminders')
@login_required
def api_cms_reminders():
    done = request.args.get('done', '0') == '1'
    return jsonify(cms_portal.cms_get_reminders(done))

@app.route('/api/cms/reminders/save', methods=['POST'])
@login_required
def api_cms_reminder_save():
    d = request.get_json()
    d['created_by'] = session.get('UID', '')
    return jsonify(cms_portal.cms_save_reminder(d))
