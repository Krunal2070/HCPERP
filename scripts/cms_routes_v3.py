# ══════════════════════════════════════════════════════════════════════════════
# CMS v3 ROUTES — add to app.py
# Add: import cms_portal
# Add at startup: cms_portal.cms_v3_init_db()
# ══════════════════════════════════════════════════════════════════════════════

import cms_portal

# Init on startup
cms_portal.cms_v3_init_db()


# ── PAGE ─────────────────────────────────────────────────────────────────────
@app.route('/cms')
@login_required
def cms_page():
    return render_template('cms.html')


# ── LEDGER GROUPS ─────────────────────────────────────────────────────────────
@app.route('/api/cms/ledger_groups')
@login_required
def api_ledger_groups():
    return jsonify(cms_portal.cms_get_ledger_groups())


# ── LEDGERS ───────────────────────────────────────────────────────────────────
@app.route('/api/cms/ledgers')
@login_required
def api_ledgers():
    return jsonify(cms_portal.cms_get_ledgers(
        ledger_type=request.args.get('type',''),
        group_id=request.args.get('group_id'),
        search=request.args.get('q','')
    ))

@app.route('/api/cms/ledgers/save', methods=['POST'])
@login_required
def api_ledger_save():
    return jsonify(cms_portal.cms_save_ledger(request.get_json()))

@app.route('/api/cms/ledgers/delete', methods=['POST'])
@login_required
def api_ledger_delete():
    d = request.get_json()
    return jsonify(cms_portal.cms_delete_ledger(d['id']))

@app.route('/api/cms/ledgers/<int:lid>/report')
@login_required
def api_ledger_report(lid):
    return jsonify(cms_portal.cms_ledger_report(
        lid,
        from_date=request.args.get('from',''),
        to_date=request.args.get('to','')
    ))

@app.route('/api/cms/ledgers/<int:lid>/advances')
@login_required
def api_ledger_advances(lid):
    return jsonify(cms_portal.cms_get_pending_advances(lid))


# ── VOUCHERS ──────────────────────────────────────────────────────────────────
@app.route('/api/cms/vouchers')
@login_required
def api_vouchers_list():
    return jsonify(cms_portal.cms_get_vouchers(
        from_date=request.args.get('from',''),
        to_date=request.args.get('to',''),
        vtype=request.args.get('type',''),
        ledger_id=request.args.get('ledger_id'),
        page=int(request.args.get('page',1)),
        per_page=int(request.args.get('per_page',20))
    ))

@app.route('/api/cms/vouchers/<int:vid>')
@login_required
def api_voucher_get(vid):
    v = cms_portal.cms_get_voucher(vid)
    if not v: return jsonify({'error':'not found'}), 404
    return jsonify(v)

@app.route('/api/cms/vouchers/save', methods=['POST'])
@login_required
def api_voucher_save():
    data = request.get_json()
    data['created_by'] = session.get('username','')
    return jsonify(cms_portal.cms_save_voucher(data))

@app.route('/api/cms/vouchers/delete', methods=['POST'])
@login_required
def api_voucher_delete():
    d = request.get_json()
    return jsonify(cms_portal.cms_delete_voucher(d['id']))


# ── REPORTS ───────────────────────────────────────────────────────────────────
@app.route('/api/cms/dashboard')
@login_required
def api_cms_dashboard():
    return jsonify(cms_portal.cms_dashboard(
        from_date=request.args.get('from',''),
        to_date=request.args.get('to','')
    ))

@app.route('/api/cms/report/daily')
@login_required
def api_cms_daily():
    from datetime import date
    dt = request.args.get('date', date.today().isoformat())
    return jsonify(cms_portal.cms_daily_report(dt))

@app.route('/api/cms/report/category')
@login_required
def api_cms_category():
    return jsonify(cms_portal.cms_category_report(
        from_date=request.args.get('from',''),
        to_date=request.args.get('to',''),
        nature=request.args.get('nature','expense')
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
    done = request.args.get('done','0') == '1'
    return jsonify(cms_portal.cms_get_reminders(done))

@app.route('/api/cms/reminders/save', methods=['POST'])
@login_required
def api_cms_reminder_save():
    d = request.get_json()
    d['created_by'] = session.get('username','')
    return jsonify(cms_portal.cms_save_reminder(d))
