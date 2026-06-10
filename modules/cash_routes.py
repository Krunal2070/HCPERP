"""
cash_routes.py
──────────────────────────────────────────────────────────────────────────────
Blueprint for Cash Management (Transactions, Loan Entries, Scrap Hisab).
These routes were previously embedded in app.py's home() function and
served from index.html. They are now separated into their own Blueprint.

Register in app.py:
    from cash_routes import cash_bp, get_excel_instance, get_transaction_data
    from cash_routes import get_loan_data, get_scrap_data
    app.register_blueprint(cash_bp)

The home() route in app.py should be updated to redirect cash users here
OR serve a KPI-card index. See updated app.py guidance below.

Excel helper functions are kept here to avoid circular imports.
Pass the SERVER_PATH string when calling init_cash_routes().
──────────────────────────────────────────────────────────────────────────────
"""

from flask import Blueprint, render_template, request, jsonify, session, redirect, url_for
from functools import wraps
from datetime import datetime
import os

import sampling_portal  # for get_db_connection etc.

cash_bp = Blueprint('cash', __name__)

# ── Excel server path — set once via init_cash_routes() ──────────────────────
_SERVER_PATH = r"\\Hcp-server\d\DEPARTMENT COMMON\PURCHASE\PETTY CASH\PETTY CASH FROM 25-26 new.xlsx"


def init_cash_routes(server_path: str):
    """Call from app.py after import to set the Excel file path."""
    global _SERVER_PATH
    _SERVER_PATH = server_path


# ─── Auth helpers ─────────────────────────────────────────────────────────────

def _login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if not session.get('logged_in'):
            return redirect('/login')
        return f(*args, **kwargs)
    return decorated


def _can_cash(section):
    """True if user may access the given cash section."""
    role = session.get('User_Type', '')
    if role == 'admin':
        return True
    uid = session.get('user_id')
    pages = {'transaction', 'loan', 'scrap'}
    # Purchase role gets all three
    if role == 'Purchase':
        return section in pages
    if role == 'User':
        return section in pages
    # Check permissions table
    if uid:
        try:
            perms = sampling_portal.get_user_permissions(uid) or {}
            if perms.get(f'page:{section}'):
                return True
        except Exception:
            pass
    return False


def _denied(label='this page'):
    return (
        f"""<!DOCTYPE html><html><head><title>Access Denied</title>
<style>body{{font-family:sans-serif;background:#f8fafc;display:flex;
align-items:center;justify-content:center;min-height:100vh;margin:0}}
.box{{background:#fff;border-radius:16px;padding:56px 48px;text-align:center;
box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:400px}}
h2{{color:#dc2626;margin:0 0 8px}} a{{color:#0d9488;font-weight:600;text-decoration:none}}
</style></head><body><div class="box">
<h2>&#128274; Access Denied</h2><p>No permission for <strong>{label}</strong></p>
<br><a href="/">&#8592; Back to Portal</a></div></body></html>""",
        403
    )


# ─── Excel helpers ────────────────────────────────────────────────────────────

def get_excel_instance():
    try:
        import xlwings as xw
        try:
            return xw.books['PETTY CASH FROM 25-26 new.xlsx']
        except Exception:
            return xw.Book(_SERVER_PATH)
    except Exception as e:
        print(f"Excel Connection Error: {e}")
        return None


def get_transaction_data():
    wb = get_excel_instance()
    if not wb:
        return [], 1
    sheet = wb.sheets["EXPENSE DETAILS"]
    last_row = sheet.range('A' + str(sheet.cells.last_cell.row)).end('up').row
    vouchers = sheet.range(f"B5:B{last_row}").value
    max_v = 0
    if vouchers:
        if not isinstance(vouchers, list):
            vouchers = [vouchers]
        for v in vouchers:
            try:
                val = int(float(v))
                if val > max_v:
                    max_v = val
            except Exception:
                continue
    data = sheet.range(f"A5:F{last_row}").value if last_row >= 5 else []
    if last_row == 5 and data:
        data = [data]
    rows = []
    for i, row in enumerate(data):
        if row and row[0]:
            d_obj = row[0] if isinstance(row[0], datetime) else datetime.now()
            rows.append({
                "row_idx": i + 5,
                "date_display": d_obj.strftime("%d-%m-%Y"),
                "voucher": row[1],
                "particulars": str(row[2] or ""),
                "credit": row[3] or 0,
                "debit": row[4] or 0,
                "balance": row[5] or 0,
            })
    return rows[::-1], max_v + 1


def get_loan_data():
    wb = get_excel_instance()
    if not wb:
        return [], 0
    sheet = wb.sheets["ADV. EXP CASH GIVEN"]
    total_loan = sheet.range('D2').value or 0
    last_row = sheet.range('C' + str(sheet.cells.last_cell.row)).end('up').row
    data = sheet.range(f"C5:D{last_row}").value if last_row >= 5 else []
    if last_row == 5 and data:
        data = [data]
    rows = [
        {"row_idx": i + 5, "name": str(row[0] or ""), "amount": row[1] or 0}
        for i, row in enumerate(data or [])
        if row and row[0]
    ]
    return rows[::-1], total_loan


def get_scrap_data():
    wb = get_excel_instance()
    if not wb:
        return []
    sheet = wb.sheets["SCRAP HISAB - JAGDAMBA"]
    last_row = sheet.range('A' + str(sheet.cells.last_cell.row)).end('up').row
    data = sheet.range(f"A6:E{last_row}").value if last_row >= 6 else []
    if last_row == 6 and data:
        data = [data]
    rows = []
    for i, row in enumerate(data or []):
        if row and row[0]:
            d_str = row[1].strftime("%Y-%m-%d") if isinstance(row[1], datetime) else str(row[1])
            rows.append({
                "row_idx": i + 6,
                "receipt": str(row[0] or ""),
                "date": d_str,
                "credit": row[2] or 0,
                "debit": row[3] or 0,
                "balance": row[4] or 0,
            })
    return rows[::-1]


# ─── Page route ───────────────────────────────────────────────────────────────

@cash_bp.route('/cash_management')
@_login_required
def cash_management_page():
    role = session.get('User_Type')

    # Determine which sections this user can see
    _INDEX_SECTION_ORDER = ['transaction', 'loan', 'scrap']
    allowed_sections = [s for s in _INDEX_SECTION_ORDER if _can_cash(s)]

    if not allowed_sections:
        return _denied('Cash Management')

    section = request.args.get('section') or allowed_sections[0]
    if section not in allowed_sections:
        return _denied(section)

    trans_list = []
    loan_list = []
    scrap_list = []
    next_v = None
    total_loan_amt = None
    cash_in_hand = None
    safe_cash = None

    wb = get_excel_instance()
    if not wb:
        return render_template(
            'cash_management.html',
            role=role,
            user_name=session.get('User_Name'),
            allowed_sections=allowed_sections,
            entries=[],
            next_voucher=None,
            loan_entries=[],
            total_loan=None,
            scrap_entries=[],
            cash_in_hand=None,
            safe_cash=None,
            active_section=section,
            excel_error="Excel file unavailable — data could not be loaded.",
        )

    sh_exp = wb.sheets["EXPENSE DETAILS"]

    if 'transaction' in allowed_sections:
        trans_list, next_v = get_transaction_data()
        cash_in_hand = sh_exp.range('F2').value or 0
        safe_cash    = sh_exp.range('D3').value or 0

    if 'loan' in allowed_sections:
        loan_list, total_loan_amt = get_loan_data()

    if 'scrap' in allowed_sections:
        scrap_list = get_scrap_data()

    return render_template(
        'cash_management.html',
        role=role,
        user_name=session.get('User_Name'),
        allowed_sections=allowed_sections,
        entries=trans_list,
        next_voucher=next_v,
        loan_entries=loan_list,
        total_loan=total_loan_amt,
        scrap_entries=scrap_list,
        cash_in_hand=cash_in_hand,
        safe_cash=safe_cash,
        active_section=section,
    )


# ─── Save / Delete routes (same logic as original app.py) ────────────────────

@cash_bp.route('/cash/save', methods=['POST'])
@_login_required
def cash_save_entry():
    data = request.json
    t = data.get('type')
    wb = get_excel_instance()
    if not wb:
        return jsonify({"status": "error", "message": "Excel Unavailable"})
    sheet = wb.sheets["SCRAP HISAB - JAGDAMBA"] if t == 'scrap' else \
           (wb.sheets["ADV. EXP CASH GIVEN"]    if t == 'loan' else wb.sheets["EXPENSE DETAILS"])
    nr = int(data.get('row_idx')) if data.get('row_idx') else \
         sheet.range(('C' if t == 'loan' else 'A') + str(sheet.cells.last_cell.row)).end('up').row + 1
    if t == 'loan':
        sheet.range(f'C{nr}').value = data['name']
        sheet.range(f'D{nr}').value = float(data.get('added_loan', 0)) + float(data.get('prev_loan', 0))
    elif t == 'scrap':
        sheet.range(f'A{nr}').value = data['receipt']
        sheet.range(f'B{nr}').value = datetime.strptime(data['date'], '%Y-%m-%d')
        sheet.range(f'C{nr}').value = float(data['credit'] or 0)
        sheet.range(f'D{nr}').value = float(data['debit'] or 0)
    else:
        if not data.get('row_idx'):
            sheet.range(f'A{nr}').value = datetime.now()
        sheet.range(f'B{nr}').value = data['voucher']
        sheet.range(f'C{nr}').value = data['particulars']
        sheet.range(f'D{nr}').value = float(data['credit'] or 0)
        sheet.range(f'E{nr}').value = float(data['debit'] or 0)
    wb.save()
    return jsonify({"status": "success"})


@cash_bp.route('/cash/delete', methods=['POST'])
@_login_required
def cash_delete_entry():
    data = request.json
    t = data.get('type')
    row_idx = data.get('row_idx')
    if not row_idx:
        return jsonify({"status": "error", "message": "No row selected"})
    wb = get_excel_instance()
    if not wb:
        return jsonify({"status": "error", "message": "Excel Unavailable"})
    if t == 'scrap':
        sheet = wb.sheets["SCRAP HISAB - JAGDAMBA"]
    elif t == 'loan':
        sheet = wb.sheets["ADV. EXP CASH GIVEN"]
    else:
        sheet = wb.sheets["EXPENSE DETAILS"]
    try:
        sheet.range(f"{int(row_idx)}:{int(row_idx)}").delete()
        wb.save()
        return jsonify({"status": "success"})
    except Exception as e:
        return jsonify({"status": "error", "message": str(e)})
