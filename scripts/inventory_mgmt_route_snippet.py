# ═══════════════════════════════════════════════════════════════════
# Snippet — apply this logic in your inventory_mgmt route (the route
# that renders inventory_mgmt.html).
#
# WHY: inventory_mgmt.html already gates every edit/create/update/delete
# control behind  {% if can_edit %}  blocks. So the only change needed
# to make RM_Store users read-only is to pass can_edit=False for them.
# ═══════════════════════════════════════════════════════════════════

from flask import session, render_template


@inventory_mgmt_bp.route('/inventory_mgmt')
def inventory_mgmt():
    if not session.get('logged_in'):
        return redirect(url_for('login'))

    user_type = (session.get('User_Type', '') or '').strip()
    user_type_lc = user_type.lower()

    # ── Read-only roles ───────────────────────────────────────────
    # RM_Store: can VIEW the page but cannot create/edit/update/delete.
    READ_ONLY_TYPES = {'rm_store', 'rm store', 'rmstore', 'rm-store'}

    if user_type_lc == 'admin':
        can_edit = True
    elif user_type_lc in READ_ONLY_TYPES:
        can_edit = False                     # ← view only
    else:
        # …existing logic for other roles…
        can_edit = True   # or whatever default applies in your app

    return render_template(
        'inventory_mgmt.html',
        can_edit=can_edit,
        # …other context vars your route already passes…
    )


# ═══════════════════════════════════════════════════════════════════
# ALSO — protect the API endpoints server-side, never trust the UI.
# Add this guard at the top of every POST/PUT/DELETE inventory API.
# ═══════════════════════════════════════════════════════════════════

def _is_read_only_user():
    ut = (session.get('User_Type', '') or '').strip().lower()
    return ut in {'rm_store', 'rm store', 'rmstore', 'rm-store'}


@inventory_mgmt_bp.route('/api/inventory_mgmt/save', methods=['POST'])
def api_inventory_save():
    if not session.get('logged_in'):
        return jsonify({'ok': False, 'error': 'not logged in'}), 401
    if _is_read_only_user():
        return jsonify({'ok': False, 'error': 'View-only access'}), 403
    # …existing save logic…


# Apply the same _is_read_only_user() guard to ALL of these endpoints:
#   /api/inventory_mgmt/save
#   /api/inventory_mgmt/update
#   /api/inventory_mgmt/delete
#   /api/inventory_mgmt/grn/create
#   /api/inventory_mgmt/grn/save
#   /api/inventory_mgmt/grn/delete
#   …and any other write endpoints in your inventory blueprint.
