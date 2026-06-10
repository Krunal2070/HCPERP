# ══════════════════════════════════════════════════════════════════════════════
# CMS Routes ADDENDUM — app.py
#
# These routes REPLACE or ADD to the original cms_app_routes.py.
# The key changes:
#   1. /api/cms/income — now accepts ?id= for single record fetch
#   2. /api/cms/expense — now accepts ?id= for single record fetch
#   3. /api/cms/employees/delete — new route
# ══════════════════════════════════════════════════════════════════════════════


@app.route('/api/cms/income')
@login_required
def cms_income_list():
    from_date = request.args.get('from', '')
    to_date   = request.args.get('to', '')
    rec_id    = request.args.get('id', None)
    source    = request.args.get('source', '')
    # Pass source filter via from_date hack not possible cleanly, handle in portal
    data = sampling_portal.cms_get_income(from_date, to_date, rec_id)
    # If source filter requested, filter in Python
    if source and not rec_id:
        data['records'] = [r for r in data['records'] if r.get('source','') == source]
        data['total'] = sum(float(r['amount']) for r in data['records'])
    return jsonify(data)


@app.route('/api/cms/expense')
@login_required
def cms_expense_list():
    from_date = request.args.get('from', '')
    to_date   = request.args.get('to', '')
    category  = request.args.get('category', '')
    rec_id    = request.args.get('id', None)
    data = sampling_portal.cms_get_expenses(from_date, to_date, category, rec_id)
    return jsonify(data)


@app.route('/api/cms/employees/delete', methods=['POST'])
@login_required
def cms_employees_delete():
    data = request.get_json()
    result = sampling_portal.cms_delete_employee(data['id'])
    return jsonify(result)
