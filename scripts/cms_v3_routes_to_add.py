# ══════════════════════════════════════════════════════════════════════════════
# ADD THESE TO app.py
#
# 1. At the top of app.py, add:
#       import cms_portal
#
# 2. Replace the existing /cms route with the one below.
#
# 3. Add all the routes below (search for "# ── END CMS ROUTES" and paste
#    these BEFORE that line).
# ══════════════════════════════════════════════════════════════════════════════


# ── REPLACE existing /cms route ──────────────────────────────────────────────
@app.route('/cms')
@login_required
def cms_page():
    if not can_access('cms'):
        return _denied('Cash Management System')
    cms_portal.cms_v3_init_db()          # init new schema
    sampling_portal.cms_init_db()        # keep old schema alive for now
    sampling_portal.cms_init_scrap_vendor_tables()
    return render_template(
        'cms.html',
        role=(session.get('User_Type') or '').lower(),
        user=session.get('User_Name', session.get('UID', ''))
    )


# ── LEDGER GROUPS ─────────────────────────────────────────────────────────────
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


# ── LEDGERS ───────────────────────────────────────────────────────────────────
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


# ── VOUCHERS ──────────────────────────────────────────────────────────────────
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


# ── DASHBOARD ─────────────────────────────────────────────────────────────────
@app.route('/api/cms/dashboard')
@login_required
def cms_dashboard():
    return jsonify(cms_portal.cms_dashboard(
        from_date=request.args.get('from', ''),
        to_date=request.args.get('to', '')
    ))


# ── REPORTS ───────────────────────────────────────────────────────────────────
@app.route('/api/cms/report/daily')
@login_required
def api_cms_report_daily():
    from datetime import date
    dt = request.args.get('date', date.today().isoformat())
    return jsonify(cms_portal.cms_daily_report(dt))


@app.route('/api/cms/report/category')
@login_required
def api_cms_report_category():
    return jsonify(cms_portal.cms_category_report(
        from_date=request.args.get('from', ''),
        to_date=request.args.get('to', ''),
        nature=request.args.get('nature', 'expense')
    ))


@app.route('/api/cms/report/receivables')
@login_required
def api_cms_receivables():
    return jsonify(cms_portal.cms_receivables())


@app.route('/api/cms/report/payables')
@login_required
def api_cms_payables():
    return jsonify(cms_portal.cms_payables())


@app.route('/api/cms/report/advances')
@login_required
def api_cms_advances():
    return jsonify(cms_portal.cms_advance_report())


# ── REMINDERS ─────────────────────────────────────────────────────────────────
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
