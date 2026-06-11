"""
core/menus.py  --  Single source of truth for every module's sidebar menu.

Instead of hard-coding the sidebar HTML inside each page template, every
module's menu is defined here ONCE as data. The reusable partial
`templates/partials/_sidebar.html` renders whichever module's menu you pass in,
so opening a module shows that module's menu — with one consistent,
professional design across the whole app.

USAGE (in any route):

    from menus import get_menu          # core/ is on sys.path (see app.py)
    ...
    return render_template(
        'pm_stock/pm_stock.html',
        sidebar_menu = get_menu('pm_stock'),
        active_item  = 'stock',          # which item is highlighted
        user_name    = session.get('User_Name'),
        role         = session.get('User_Type'),
    )

THEN in the template, replace the hard-coded <nav class="sidebar"> block with:

    {% include 'partials/_sidebar.html' %}

ITEM FIELDS
    id      : unique key; also used to match `active_item` and as sb-<id> DOM id
    text    : label shown
    icon    : raw inline SVG (or '<i class="fas fa-..."></i>')
    href    : navigate to a URL            (use this OR action)
    action  : JS onclick string            (e.g. "switchTab('stock')")
    kbd     : keyboard hint shown on right  (optional, e.g. "Alt+5")
    badge   : DOM id for a live count badge (optional; JS fills it)
    title   : tooltip (optional)
    gate    : access-key; item hidden if access[gate] is False (optional)
    admin   : True => only shown to admin role (optional)
"""

# ── Reusable SVG icons (stroke-based, theme-coloured via currentColor) ───────
_IC = {
    "grid":     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
    "download": '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    "upload":   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
    "warning":  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    "trash":    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    "target":   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
    "chart":    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    "lock":     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    "box":      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    "users":    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    "ledger":   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>',
    "bom":      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 3v18M3 9h18M3 15h18M15 3v18"/></svg>',
    "plus":     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/></svg>',
    "check":    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>',
    "tag":      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M20.59 13.41 11 3.83A2 2 0 0 0 9.59 3H4a1 1 0 0 0-1 1v5.59A2 2 0 0 0 3.83 11l9.58 9.59a2 2 0 0 0 2.83 0l4.35-4.35a2 2 0 0 0 0-2.83z"/><circle cx="7.5" cy="7.5" r="1"/></svg>',
    "list":     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>',
    "move":     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 12h13l-3-3m3 3l-3 3"/><path d="M21 6v12"/></svg>',
    "request":  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 11l-4 4 4 4"/><path d="M5 15h11a4 4 0 0 0 4-4V5"/></svg>',
    "adjust":   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 6h18"/><path d="M7 12h10"/><path d="M10 18h4"/><circle cx="6" cy="6" r="1.5"/><circle cx="14" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/></svg>',
    "flask":    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 3v6l-5 9a3 3 0 0 0 2.6 4.5h10.8A3 3 0 0 0 20 18l-5-9V3"/><path d="M8 3h8"/></svg>',
    "po":       '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>',
    "shield":   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    "report":   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9h6M9 12h6M9 15h4"/></svg>',
    "cash":     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/><path d="M6 12h.01M18 12h.01"/></svg>',
    "doc":      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
    "print":    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>',
    "gear":     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    "mail":     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-10 5L2 7"/></svg>',
    "chat":     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8z"/></svg>',
    "palette":  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2a10 10 0 0 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.4-.5-.8-.5-1.2 0-1.1.9-2 2-2h2.4A4.6 4.6 0 0 0 22 11 10 10 0 0 0 12 2z"/></svg>',
    "home":     '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>',
    "groups":   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"/></svg>',
}


# ── Per-module menu definitions ──────────────────────────────────────────────
# Add a new module by adding a key here. Nothing else changes.
MENUS = {

    # ===== PM STOCK (the module in the screenshot) ===========================
    # Each item carries permission metadata so get_menu() reproduces the exact
    # gating the old hard-coded template had:
    #   gate            : show only if access[gate] is True
    #   hide_requester  : hide for FACTORY "requester" users
    #   admin_only      : show only to admin role
    #   non_admin_only  : show only to non-admin roles
    #   role_not        : hide for this exact role string
    "pm_stock": {
        "brand": "HCP Wellness",
        "tag":   "PM Stock v3",
        "search": True,
        "sections": [
            {"label": "Stock", "gate": "stock_pages", "items": [
                {"id": "stock",    "text": "Stock View", "icon": _IC["grid"], "action": "switchTab('stock');setSidebarActive('stock')", "kbd": "Alt+1"},
                {"id": "combined", "text": "Combined",   "icon": _IC["grid"], "action": "switchTab('combined');setSidebarActive('combined')", "kbd": "Alt+2", "hide_requester": True},
                {"id": "find-box", "text": "Find Box",   "icon": _IC["grid"], "action": "openFindBoxModal()", "hide_requester": True},
                {"id": "split-box","text": "Split Box",  "icon": _IC["grid"], "action": "openSplitBoxModal()", "hide_requester": True},
            ]},
            {"label": "Masters", "hide_requester": True, "items": [
                {"id": "products",   "text": "Products",          "icon": _IC["box"],    "action": "switchTab('products');setSidebarActive('products')",   "kbd": "Alt+5"},
                {"id": "suppliers",  "text": "Supplier Directory", "icon": _IC["users"],  "action": "switchTab('suppliers');setSidebarActive('suppliers')", "kbd": "Alt+9"},
                {"id": "sup-ledger", "text": "Supplier PM Ledger", "icon": _IC["ledger"], "action": "switchTab('sup-ledger');setSidebarActive('sup-ledger')","kbd": "Alt+0"},
                {"id": "bom",        "text": "BOM Manager",        "icon": _IC["bom"],    "action": "openBomManagerModal()", "gate": "bom_manage", "gate_or_admin": True},
            ]},
            {"label": "Vouchers", "items": [
                {"id": "add-new", "dom_id": "btn-add-new", "text": "Add New", "icon": _IC["plus"], "action": "openAddNewModal()",                                   "hide_requester": True, "gate": "new_voucher_entries"},
                {"id": "audit",      "text": "Physical Stock Check","icon": _IC["check"],  "href": "/pm_stock/audit",                                        "hide_requester": True, "gate": "new_voucher_entries", "kbd": "Alt+U"},
                {"id": "voucher-no", "text": "Voucher #",           "icon": _IC["tag"],    "action": "pmvOpenVoucherSettings()",                            "hide_requester": True, "gate": "new_voucher_entries", "role_not": "PM", "kbd": "Alt+T"},
                {"id": "my-fifo-override", "dom_id": "my-fifo-override-btn", "text": "My FIFO Overrides", "icon": _IC["shield"], "action": "openMyFifoOverridesModal()",                      "non_admin_only": True, "badge": "my-fifo-override-badge", "badge_hidden": True},
                {"id": "grn",        "text": "Voucher Log",         "icon": _IC["check"],  "action": "switchTab('grn');setSidebarActive('grn')",            "hide_requester": True, "gate": "voucher_log", "kbd": "Alt+3"},
                {"id": "mm",         "text": "Material Movement",   "icon": _IC["move"],   "action": "switchTab('mm');setSidebarActive('mm')",  "badge": "sb-mm-pending", "badge_hidden": True, "kbd": "Alt+6"},
                {"id": "mr",         "text": "Material Request",    "icon": _IC["request"],"action": "gotoMrTab()",                                         "gate": "material_request", "badge": "sb-mr-count", "badge_hidden": True},
                {"id": "adj",        "text": "Stock Adjustment",    "icon": _IC["adjust"], "action": "switchTab('adj');setSidebarActive('adj')",            "gate": "stock_adjustment", "badge": "sb-adj-pending", "badge_hidden": True},
                {"id": "trs",        "text": "PM TRS",              "icon": _IC["flask"],  "action": "switchTab('trs');setSidebarActive('trs')",            "gate": "pm_trs", "badge": "sb-trs-pending", "badge_hidden": True},
                {"id": "po",         "text": "Purchase Orders",     "icon": _IC["po"],     "action": "switchTab('purchase-orders');setSidebarActive('purchase-orders')"},
                {"id": "log",        "text": "Log",                 "icon": _IC["doc"],    "action": "switchTab('log');setSidebarActive('log')",            "hide_requester": True, "kbd": "Alt+4"},
            ]},
            {"label": "Admin", "admin_only": True, "items": [
                {"id": "admin-panel", "dom_id": "btn-admin-panel", "text": "Admin Panel", "icon": _IC["shield"], "action": "openAdminPanelModal()", "badge": "admin-panel-pending-badge", "badge_hidden": True},
            ]},
            {"label": "Reports", "hide_requester": True, "items": [
                {"id": "reports", "text": "Reports", "icon": _IC["report"], "action": "openReportsHub();setSidebarActive('reports')", "kbd": "Alt+Y"},
            ]},
            {"label": "Navigate", "items": [
                {"id": "task-scheduler", "text": "Task Scheduler", "icon": _IC["doc"],  "href": "/task_scheduler", "kbd": "Alt+K"},
                {"id": "home",           "text": "Back to Portal", "icon": _IC["grid"], "href": "/",               "kbd": "Alt+H"},
            ]},
        ],
    },

    # ===== CMS (Cash Management) — link/href style example ===================
    "cms": {
        "brand": "HCP Wellness",
        "tag":   "Cash Management",
        "search": True,
        "sections": [
            {"label": "Cash", "items": [
                {"id": "cms-home",    "text": "Dashboard",  "icon": _IC["grid"], "href": "/cms"},
                {"id": "cms-cash",    "text": "Cash Book",  "icon": _IC["cash"], "href": "/cash_management"},
                {"id": "cms-vouchers","text": "Vouchers",   "icon": _IC["doc"],  "href": "/cms#vouchers"},
            ]},
            {"label": "Reports", "items": [
                {"id": "cms-reports", "text": "Reports", "icon": _IC["report"], "href": "/cms#reports"},
            ]},
        ],
    },

    # ===== PACKING — the page we just restored ==============================
    "packing": {
        "brand": "HCP Wellness",
        "tag":   "Packing Entry",
        "search": False,
        "sections": [
            {"label": "Packing", "items": [
                {"id": "packing-list", "text": "Entries",  "icon": _IC["list"], "href": "/packing"},
            ]},
        ],
    },

    # ===== PROCUREMENT (faithful to the live sidebar) ======================
    # Keeps sidebar-item class + sb-<id> ids + sbBadge-* ids + the exact
    # onclick actions so switchTab/setSidebarActive, modals, the Suppliers
    # submenu and live badges all keep working. Admin items gate on UID=='admin'
    # (pass is_admin from the route).
    "procurement": {
        "brand": "HCP Wellness",
        "tag":   "Procurement",
        "search": True,
        "item_class": "sidebar-item",
        "sections": [
            {"label": "Materials", "items": [
                {"id": "mqsd", "dom_id": "sb-mqsd", "text": "Material Master",     "icon": _IC["grid"],   "action": "switchTab('mqsd');setSidebarActive('mqsd')", "badge": "sbBadge-mqsd", "badge_init": "–"},
                {"id": "matGroups",                  "text": "Material Groups",     "icon": _IC["groups"], "action": "openGroupsManager()", "title": "Manage material groups", "badge": "sbBadge-matGroups", "badge_init": "–"},
                {"id": "fvq",  "dom_id": "sb-fvq",  "text": "Formulations vs Qty", "icon": _IC["bom"],    "action": "switchTab('fvq');setSidebarActive('fvq')", "badge": "sbBadge-fvq", "badge_init": "–"},
            ]},
            {"label": "Vouchers", "items": [
                {"id": "po", "dom_id": "sb-po", "text": "Purchase Orders", "icon": _IC["po"], "action": "switchTab('po');setSidebarActive('po')", "badge": "sbBadge-po", "badge_init": "–"},
            ]},
            {"label": "Procurement", "items": [
                {"id": "terms",      "text": "Terms & Conditions", "icon": _IC["doc"], "action": "openTCManager()", "title": "Manage general terms & conditions lists"},
                {"id": "voucher-no", "text": "Voucher Numbering",  "icon": _IC["tag"], "action": "openVoucherNumSettings()", "title": "Configure numbering for all voucher types"},
                {"id": "sup-head", "dom_id": "sb-sup-head", "text": "Suppliers", "icon": _IC["users"], "badge": "sbBadge-sup", "badge_init": "–", "submenu": [
                    {"id": "sup",        "dom_id": "sb-sup",        "text": "Suppliers",        "icon": _IC["users"],  "action": "switchTab('sup');setSidebarActive('sup')"},
                    {"id": "sup-ledger", "dom_id": "sb-sup-ledger", "text": "Supplier Ledger",  "icon": _IC["ledger"], "action": "openSupLedgerTab()"},
                    {"id": "sup-types",                              "text": "Supplier Types",   "icon": _IC["groups"], "action": "openSupTypeManager()"},
                ]},
            ]},
            {"label": "Quick Actions", "items": [
                {"id": "rm-req",     "text": "RM Requirement",      "icon": _IC["request"], "action": "openRMRequirement()"},
                {"id": "cost-kg",    "text": "Cost per KG",         "icon": _IC["cash"],    "action": "switchTab('fvq');setSidebarActive('fvq');setTimeout(openCostPerKgReport,200)"},
                {"id": "godowns",    "text": "Godowns & Addresses", "icon": _IC["home"],    "action": "try{openGodownManager()}catch(e){console.error(e)}", "title": "Manage godowns, billing & shipping addresses"},
                {"id": "general-op", "text": "General OP",          "icon": _IC["grid"],    "href": "/general_op", "target": "_blank", "title": "General Operations"},
                {"id": "po-approvers","text": "PO Approvers",       "icon": _IC["shield"],  "action": "openPoApproversModal()", "admin_only": True, "admin_tag": True, "title": "Admin only — manage who can approve POs"},
                {"id": "email-log",  "text": "Email Send Log",      "icon": _IC["mail"],    "action": "openEmailLogModal()",    "admin_only": True, "admin_tag": True, "title": "Admin only — PO email history"},
                {"id": "settings",   "text": "Settings",            "icon": _IC["gear"],    "action": "openSettings()"},
                {"id": "inventory",  "text": "Inventory",           "icon": _IC["grid"],    "href": "/inventory_mgmt"},
                {"id": "home",       "text": "Back to Portal",      "icon": _IC["home"],    "href": "/"},
            ]},
        ],
    },

    # ===== RM STORE / R&D (from screenshot 1) ===============================
    "rm_store": {
        "brand": "HCP Wellness",
        "tag":   "RM Store",
        "search": True,
        "sections": [
            {"label": "Reports", "items": [
                {"id": "dispensing-records", "text": "Daily Dispensing Records", "icon": _IC["report"], "href": "/rm_store#records", "kbd": "D"},
            ]},
            {"label": "Inventory", "items": [
                {"id": "rm-stock", "text": "RM Stock", "icon": _IC["box"], "href": "/rm_store#stock"},
            ]},
            {"label": "Batch Management", "items": [
                {"id": "add-batch",    "text": "Add Batch",         "icon": _IC["plus"],  "href": "/rm_store#add", "kbd": "A"},
                {"id": "print-sheets", "text": "Print Sheets",      "icon": _IC["print"], "href": "/rm_store#sheets"},
                {"id": "print-labels", "text": "Print Batch Labels","icon": _IC["tag"],   "href": "/rm_store#labels"},
            ]},
            {"label": "Production", "items": [
                {"id": "dispensing-ready", "text": "Dispensing Ready", "icon": _IC["flask"],   "href": "/rm_store#ready"},
                {"id": "rm-requirement",   "text": "RM Requirement",   "icon": _IC["list"],    "href": "/rm_store#req"},
            ]},
            {"label": "Admin Reports", "items": [
                {"id": "batch-confirm", "text": "Batch Confirmation", "icon": _IC["check"], "href": "/rm_store#confirm"},
                {"id": "bst",           "text": "BST",                "icon": _IC["grid"],  "href": "/rm_store#bst"},
            ]},
            {"label": "Communication", "items": [
                {"id": "whatsapp", "text": "WhatsApp", "icon": _IC["chat"], "href": "/rm_store#whatsapp", "color": "#16a34a"},
            ]},
            {"label": "Requests", "items": [
                {"id": "material-requests", "text": "Material Requests", "icon": _IC["request"], "href": "/rm_store#requests"},
            ]},
            {"label": "Tools", "items": [
                {"id": "tasks",      "text": "Tasks",      "icon": _IC["check"],   "href": "/task_reminders"},
                {"id": "appearance", "text": "Appearance", "icon": _IC["palette"], "href": "/rm_store#theme", "kbd": "^J"},
            ]},
            {"label": "Admin Tools", "admin_only": True, "items": [
                {"id": "access-control", "text": "Access Control", "icon": _IC["users"], "href": "/access_control"},
            ]},
        ],
    },

    # ===== QC DASHBOARD (from screenshot) ===================================
    # switchTab() removes .active from all .sb-item then adds it to
    # getElementById('sb-'+tab), so items keep the sb-item class + sb-<tab> ids.
    # Badges show live counts (start as "—"), filled by the page's JS.
    "qc": {
        "brand": "HCP Wellness",
        "tag":   "Quality Control",
        "search": False,
        "item_class": "sb-item",
        "sections": [
            {"label": "QC Sections", "items": [
                {"id": "ipm",   "dom_id": "sb-ipm",   "text": "In Process Material", "icon": _IC["grid"],    "action": "switchTab('ipm')",   "badge": "sb-badge-ipm",   "badge_init": "—", "color": "#4f46e5"},
                {"id": "qcs",   "dom_id": "sb-qcs",   "text": "Purchase Samples",    "icon": _IC["flask"],   "action": "switchTab('qcs')",   "badge": "sb-badge-qcs",   "badge_init": "—", "color": "#7c3aed"},
                {"id": "trs",   "dom_id": "sb-trs",   "text": "RM TRS",              "icon": _IC["flask"],   "action": "switchTab('trs')",   "badge": "sb-badge-trs",   "badge_init": "—", "color": "#0d9488"},
                {"id": "pmtrs", "dom_id": "sb-pmtrs", "text": "PM TRS",              "icon": _IC["box"],     "action": "switchTab('pmtrs')", "badge": "sb-badge-pmtrs", "badge_init": "—", "color": "#ea580c"},
            ]},
        ],
    },

    # ===== HCP STOCK / STOCK REGISTER (from screenshot) ====================
    # Buttons keep the sb-btn class + data-feature attr so the page's
    # permission-hide JS keeps working; emoji icons replaced by ASCII-safe SVG.
    # Admin section gated by is_admin (passed from the route).
    "hcp_stock": {
        "brand": "HCP Wellness",
        "tag":   "Stock Register",
        "search": False,
        "item_class": "sb-btn",
        "sections": [
            {"label": "Add New", "items": [
                {"id": "new-pm",   "text": "New PM",          "icon": _IC["plus"],     "action": "openPmModal()",       "data_feature": "add_pm"},
                {"id": "new-fg",   "text": "New Product (FG)", "icon": _IC["plus"],     "action": "openFgModal()",       "data_feature": "add_fg"},
                {"id": "new-inw",  "text": "New Inward",       "icon": _IC["download"], "action": "switchTab('inward'); setTimeout(openMultiInwardModal, 100);",     "data_feature": "add_inward"},
                {"id": "new-dis",  "text": "New Dispatch",     "icon": _IC["upload"],   "action": "switchTab('dispatch'); setTimeout(openMultiDispatchModal, 100);", "data_feature": "add_dispatch"},
                {"id": "new-was",  "text": "New Wastage",      "icon": _IC["warning"],  "action": "switchTab('wastage'); setTimeout(openMultiWastageModal, 100);",   "data_feature": "add_wastage"},
                {"id": "new-req",  "text": "New Requirement",  "icon": _IC["target"],   "action": "openMultiReqModal()", "data_feature": "set_requirement"},
            ]},
            {"label": "Data", "items": [
                {"id": "imp-xl",   "text": "Import Excel",         "icon": _IC["download"], "action": "document.getElementById('import-file').click();", "data_feature": "data_import"},
                {"id": "exp-xl",   "text": "Export Excel",         "icon": _IC["upload"],   "action": "exportExcel()",   "data_feature": "data_export"},
                {"id": "exp-pm",   "text": "Export PM (formatted)","icon": _IC["chart"],    "action": "exportPmExcel()", "data_feature": "data_export"},
                {"id": "dl-tpl",   "text": "Download Template",    "icon": _IC["download"], "action": "window.location.href='/hcp_stock/template/download'", "data_feature": "data_template"},
                {"id": "check-pm", "text": "Check PM",             "icon": _IC["grid"],     "action": "switchTab('fg'); setTimeout(openPlanModal, 100);", "data_feature": "data_check_pm"},
            ]},
            {"label": "Reports", "items": [
                {"id": "reports",     "text": "Reports",                "icon": _IC["report"], "action": "openReportsHub()"},
                {"id": "req-vs-disp", "text": "Requirement vs Dispatch","icon": _IC["chart"],  "action": "openReqVsDispatchReport()", "data_feature": "report_req_dispatch"},
                {"id": "req-hist",    "text": "Requirement History",    "icon": _IC["list"],   "action": "openRequirementHistory()",  "data_feature": "report_req_history"},
            ]},
            {"label": "Admin", "admin_only": True, "items": [
                {"id": "uac",        "text": "User Access Control", "icon": _IC["lock"],  "action": "openPermissionsModal()", "color": "#7c3aed"},
                {"id": "recycle",    "text": "Recycle Bin",         "icon": _IC["trash"], "action": "openRecycleBin()",       "color": "#7c3aed"},
                {"id": "audit-log",  "text": "Audit Log",           "icon": _IC["doc"],   "action": "openAuditLog()",         "color": "#7c3aed"},
                {"id": "clear-tbl",  "text": "Clear Tables",        "icon": _IC["warning"],"action": "openClearModal()",      "color": "#dc2626"},
            ]},
        ],
    },
    # ===== CRM / LEADS ====================================================
    "crm": {
        "brand": "HCP Wellness",
        "tag":   "CRM",
        "search": False,
        "item_class": "sb-item",
        "sections": [
            {"label": "CRM", "items": [
                {"id": "crm-dash",   "text": "CRM Dashboard",      "icon": _IC["grid"],     "href": "/crm/leads",   "color": "#7c3aed"},
                {"id": "leads",      "text": "Leads",              "icon": _IC["users"],    "href": "/crm/leads",   "color": "#2563eb"},
                {"id": "clients",    "text": "Client Master",      "icon": _IC["box"],      "href": "/crm/clients", "color": "#0d9488"},
                {"id": "samples",    "text": "Sample Orders",      "icon": _IC["list"],     "href": "/crm/sample-orders",            "color": "#ea580c"},
                {"id": "quotations", "text": "Quotations",         "icon": _IC["doc"],      "href": "/crm/quotations",            "color": "#db2777"},
                {"id": "quot-prod",  "text": "Quot. Product List", "icon": _IC["list"],     "href": "/crm/quotations/products",            "color": "#0891b2"},
            ]},
            {"label": "Import", "items": [
                {"id": "imp-leads",  "text": "Import Leads",       "icon": _IC["download"], "href": "/crm/leads/import",   "color": "#2563eb"},
                {"id": "imp-clients","text": "Import Clients",     "icon": _IC["download"], "href": "/crm/clients/import", "color": "#0d9488"},
            ]},
            {"label": "Settings", "items": [
                {"id": "mail-master","text": "Mail Master",        "icon": _IC["mail"],     "href": "/mail/master",            "color": "#7c3aed"},
                {"id": "lead-mstr",  "text": "Lead Masters",       "icon": _IC["tag"],      "href": "/crm/lead-masters",            "color": "#16a34a"},
            ]},
        ],
    },
}


# Icon colour palette — cycled across items so every module gets the same
# colourful-chip look without hand-colouring each entry.
_PALETTE = ["#2563eb", "#7c3aed", "#0d9488", "#ea580c", "#16a34a",
            "#db2777", "#0891b2", "#d97706", "#4f46e5", "#dc2626"]


def _visible(node, access, is_admin, role, is_requester):
    """Apply all permission gates to a section or item dict."""
    if node.get("admin_only") and not is_admin:
        return False
    if node.get("non_admin_only") and is_admin:
        return False
    if node.get("hide_requester") and is_requester:
        return False
    if node.get("role_not") and (role or "") == node["role_not"]:
        return False
    gate = node.get("gate")
    if gate:
        allowed = (access or {}).get(gate, False)
        # gate_or_admin: admins bypass the access flag
        if node.get("gate_or_admin") and is_admin:
            allowed = True
        if not allowed:
            return False
    return True


def get_menu(module_key, access=None, role=None, is_requester=False, is_admin=None):
    """
    Return the menu definition for a module, filtered by the same permission
    logic the old hard-coded sidebars used. Items without an explicit `color`
    get one from the palette so every module looks consistent.

    access       : dict of permission flags (item hidden if access[gate] False)
    role         : current role ('admin' unlocks admin_only / gate_or_admin)
    is_requester : True for FACTORY requester users (hides most items)
    is_admin     : optional explicit admin flag (overrides role-based check;
                   some modules gate on UID=='admin' rather than role)
    Returns None if the module key is unknown.
    """
    menu = MENUS.get(module_key)
    if not menu:
        return None
    if is_admin is None:
        is_admin = (role or "").lower() == "admin"

    out_sections = []
    color_i = 0
    for sec in menu["sections"]:
        if not _visible(sec, access, is_admin, role, is_requester):
            continue
        items = []
        for it in sec["items"]:
            if not _visible(it, access, is_admin, role, is_requester):
                continue
            item = dict(it)  # copy so we never mutate the master definition
            if not item.get("color"):
                item["color"] = _PALETTE[color_i % len(_PALETTE)]
            color_i += 1
            if item.get("submenu"):
                subs = []
                for sub in item["submenu"]:
                    s = dict(sub)
                    if not s.get("color"):
                        s["color"] = _PALETTE[color_i % len(_PALETTE)]
                    color_i += 1
                    subs.append(s)
                item["submenu"] = subs
            items.append(item)
        if items:
            out_sections.append({"label": sec["label"], "items": items})

    return {
        "brand":      menu.get("brand", "HCP Wellness"),
        "tag":        menu.get("tag", ""),
        "search":     menu.get("search", False),
        "item_class": menu.get("item_class", ""),
        "sections":   out_sections,
    }
