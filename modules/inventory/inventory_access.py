r"""
inventory_access.py  –  Inventory User Access Control  (Phase 1)
================================================================
HCP Wellness Pvt Ltd

Ported from pm_stock's user-access subsystem, namespaced for the Inventory
module so it never collides with the pm_* tables.

What this provides
------------------
  • Per-user, fine-grained gating of Inventory feature categories.
  • Optional ACCESS GROUPS: an admin defines a named group with its own
    feature toggles, then assigns users to it. Resolution order at
    access-check time:
        admin                         → all access (bypass)
        else per-user explicit row    → wins
        else the user's group's row   → next
        else defaults                 → last
  • Admin REST API under /api/inventory_mgmt/access/* for the modal.
  • Helper functions other inventory phases import to guard their routes:
        _inv_user_access_dict(user=None, conn=None) -> {category: bool}
        _inv_user_has_access(category, user=None, conn=None) -> bool
        _inv_block_if_no_access(category) -> (response, 403) | None

Tables (all created here, idempotently — never touch pm_* tables):
  • inventory_user_access            – one row per customised user
  • inventory_access_groups          – named group + its feature toggles
  • inventory_access_group_members   – user → group assignment

Categories cover all 8 inventory feature phases so this module is
forward-compatible:
    stock_pages          — Stock view tabs / godown view
    voucher_log          — Voucher Log tab (Phase 5)
    new_voucher_entries  — Create new GRN / transfers (master switch)
    grn_labels           — GRN label printing
    opening_labels       — Opening Stock voucher + opening labels
    reprint_requests     — Submit label reprint requests (Phase 7)
    material_request     — Material Request feature (Phase 2)
    physical_stock_check — Physical Stock Check (Phase 8)
    material_lock        — Material Lock (Phase 4)        [default DENY]
    label_reissue        — Label Reissue Approvals (Phase 7) [default DENY]
    fefo_override        — FEFO Override Approvals (Phase 3) [default DENY]

Register in app.py (after register_inventory_mgmt):
    from inventory import inventory_access
    inventory_access.register_inventory_access(app)

API prefix:   /api/inventory_mgmt/access/*
"""

from __future__ import annotations

from functools import wraps

from flask import session, jsonify, redirect, url_for, request, g

import sampling_portal  # shared DB helper


# ─────────────────────────────────────────────────────────────────────────────
# CATEGORY DEFINITIONS
# ─────────────────────────────────────────────────────────────────────────────
# Every category is a simple Enable/Disable toggle, stored as 'off' / 'on'.
#
# POLICY: default DENY for everyone except admins. Every category defaults to
# 'off'. Admins always bypass and get full access regardless of their row.
#
# (The internal model still carries a 'kind' field and supports a 'view'/'edit'
# level for forward-compatibility, but no category currently uses it.)
#
# Adding a new category is a 3-step change:
#   1) add an entry to INV_ACCESS_CATEGORIES below,
#   2) the CREATE TABLE / migration loop picks it up automatically,
#   3) mirror it in the modal's _IAC_CATEGORIES list in the JS.

# kind: all 'boolean' now (Enable/Disable). default: all 'off' (default-deny).
INV_ACCESS_CATEGORIES = (
    {"key": "suppliers",       "label": "Suppliers",       "kind": "boolean", "default": "off",
     "desc": "View / manage Suppliers tab"},
    {"key": "items", "label": "Items (RM Master)", "kind": "level", "default": "off",
     "desc": "Items grid. Off = hidden · View = see items only · Edit = full CRUD (New / Edit / Delete)"},
    {"key": "godown_view",     "label": "Godown View",     "kind": "boolean", "default": "off",
     "desc": "Godown-wise stock view + box drill-down"},
    {"key": "stock_transfer",  "label": "Stock Transfer",  "kind": "boolean", "default": "off",
     "desc": "Stock Transfer vouchers (full transfer flow)"},
    {"key": "simple_transfer", "label": "Simple Transfer", "kind": "boolean", "default": "off",
     "desc": "Quick / simple stock transfer"},
    {"key": "manage_godown",   "label": "Manage Godown",   "kind": "boolean", "default": "off",
     "desc": "Godowns master — add / edit / delete godowns"},
    {"key": "material_request", "label": "Material Request", "kind": "boolean", "default": "off",
     "desc": "Material Request tab — create / view / fulfill requests"},
    {"key": "opening_stock",   "label": "Opening Stock",   "kind": "boolean", "default": "off",
     "desc": "Opening Stock entry + opening labels"},
    {"key": "opening_stock_view_print", "label": "Opening Stock — View / Print Only", "kind": "boolean", "default": "off",
     "desc": "Restrict to viewing + printing Opening Stock; no create / edit / delete"},
    {"key": "grn",             "label": "GRN",             "kind": "boolean", "default": "off",
     "desc": "Goods Receipt Notes tab (list + open)"},
    {"key": "grn_view_print",  "label": "GRN — View / Print Only", "kind": "boolean", "default": "off",
     "desc": "Restrict to viewing + printing GRNs; no edit / delete (overrides Edit/New GRN)"},
    {"key": "grn_edit",        "label": "Edit GRN",        "kind": "boolean", "default": "off",
     "desc": "Edit / modify an existing GRN"},
    {"key": "grn_new",         "label": "New GRN",         "kind": "boolean", "default": "off",
     "desc": "Create a new GRN voucher"},
    {"key": "fefo_override",   "label": "FEFO Override Approvals", "kind": "boolean", "default": "off",
     "desc": "Review & approve FEFO override requests (Phase 3)"},
    {"key": "material_lock",   "label": "Material Lock",   "kind": "boolean", "default": "off",
     "desc": "Manage material lock rules (Phase 4)"},
    {"key": "label_reissue",   "label": "Label Reissue Approvals", "kind": "boolean", "default": "off",
     "desc": "Review & approve label reissue requests (Phase 7)"},
    {"key": "label_reprint",   "label": "Label Reprint Approvals", "kind": "boolean", "default": "off",
     "desc": "Review & approve label reprint requests (Phase 7)"},
    {"key": "box_split",       "label": "Box Split",       "kind": "boolean", "default": "off",
     "desc": "Split a box into smaller child boxes"},
    {"key": "delivery_note",   "label": "Delivery Note",   "kind": "boolean", "default": "off",
     "desc": "Issue delivery notes (HCP -> supplier, reduces stock)"},
    {"key": "command_palette", "label": "Command Palette (Ctrl+K)", "kind": "boolean", "default": "off",
     "desc": "Keyboard launcher to search & jump to any screen"},
    {"key": "floating_dock",   "label": "Floating Dock",   "kind": "boolean", "default": "off",
     "desc": "Movable, pinnable quick-action toolbar"},
    {"key": "qr_scanner",      "label": "QR Scanner (Handheld)", "kind": "boolean", "default": "off",
     "desc": "Scan box QR labels with a USB/Bluetooth scanner"},
    {"key": "low_stock_alerts","label": "Low Stock Alerts", "kind": "boolean", "default": "off",
     "desc": "View items below their minimum stock level"},
    {"key": "stock_audit",     "label": "Physical Stock Audit", "kind": "boolean", "default": "off",
     "desc": "Run physical count sessions and reconcile variance"},
    {"key": "mobile_view",     "label": "Mobile View",     "kind": "boolean", "default": "on",
     "desc": "Phone-friendly layout with a bottom tab bar"},
    {"key": "reports",         "label": "Reports",         "kind": "boolean", "default": "off",
     "desc": "View & print stock reports (godown-wise, group-wise)"},
    {"key": "voucher_log", "label": "Voucher Log", "kind": "boolean", "default": "off",
     "desc": "View the voucher log / activity history (read-only)"},
    {"key": "db_reset",        "label": "Database Reset (Admin)", "kind": "boolean", "default": "off",
     "desc": "Reset transactional data & voucher sequence (destructive)"},
    {"key": "mr_batch_popup", "label": "MR — FEFO Batch Popup", "kind": "boolean", "default": "on",
     "desc": "Show batch list (FEFO order) when picking material on the New MR screen — helpful preview of which batches will be consumed"},
    {"key": "pending_tasks_toast", "label": "Pending Tasks Reminder", "kind": "boolean", "default": "on",
     "desc": "Top-right reminder toast every ~90 min for pending tasks (expiring batches, below-MSL items, pending MRs, in-transit transfers, stale audits)"},
    {"key": "user_control",    "label": "User Control",    "kind": "boolean", "default": "off",
     "desc": "Open the User Access Control tool"},
    {"key": "view_only", "label": "View-Only (Stocks)", "kind": "boolean", "default": "off",
     "desc": "Master read-only lock: user can VIEW stocks/reports but cannot create, edit, transfer, approve, split, issue, reconcile or reset anything. Overrides all action permissions."},
)

# Derived lookups
INV_ACCESS_KEYS    = tuple(c["key"] for c in INV_ACCESS_CATEGORIES)
INV_ACCESS_KIND    = {c["key"]: c["kind"] for c in INV_ACCESS_CATEGORIES}
INV_ACCESS_DEFAULT = {c["key"]: c["default"] for c in INV_ACCESS_CATEGORIES}
INV_ACCESS_NICE    = {c["key"]: c["label"] for c in INV_ACCESS_CATEGORIES}

# When a user has the 'view_only' lock enabled, they may VIEW stocks/reports
# but cannot perform ANY action (create / edit / transfer / approve / split /
# issue / reconcile / reset / manage). These are the capabilities that remain
# usable under the lock — everything NOT in this set is forced off.
# (Read-oriented tabs, navigation aids, and explicit "view/print only" caps.)
INV_VIEW_ONLY_ALLOWED = frozenset({
    "view_only",                 # the lock flag itself
    "items",                     # items master — view stays; edit capped by helper
    "godown_view",               # godown-wise stock view + box drill-down
    "reports",                   # view / print reports
    "voucher_log",               # read-only voucher / activity history
    "low_stock_alerts",          # view-only alert list
    "suppliers",                 # supplier directory (view)
    "opening_stock_view_print",  # explicit view/print-only opening stock
    "grn_view_print",            # explicit view/print-only GRN
    "grn",                       # GRN tab visibility (list + open); edit/new still blocked
    "command_palette",           # navigation aid
    "floating_dock",             # navigation aid
    "qr_scanner",                # lookup aid (scan to view a box)
    "mobile_view",               # layout preference
    "mr_batch_popup",            # display preference
    "pending_tasks_toast",       # passive reminder
})

# Valid stored values per kind.
_LEVEL_VALUES   = ("off", "view", "edit")
_BOOLEAN_VALUES = ("off", "on")


def _coerce_value(key, raw):
    """Normalise an incoming value to a valid stored string for this key.
    Accepts bools, ints, and strings. Booleans/ints map True→'on', False→'off'
    for boolean categories, and True→'edit'/False→'off' for level categories."""
    kind = INV_ACCESS_KIND.get(key, "boolean")
    if isinstance(raw, bool):
        if kind == "level":
            return "edit" if raw else "off"
        return "on" if raw else "off"
    if isinstance(raw, (int, float)):
        if kind == "level":
            return "edit" if raw else "off"
        return "on" if raw else "off"
    s = str(raw or "").strip().lower()
    if kind == "level":
        if s in _LEVEL_VALUES:
            return s
        # tolerate 'true'/'1'/'enabled'
        if s in ("true", "1", "yes", "enabled", "on"):
            return "edit"
        return "off"
    else:
        if s in ("on", "true", "1", "yes", "enabled", "view", "edit"):
            return "on"
        return "off"


def _is_enabled(value):
    """A category is 'enabled' (passes _inv_user_has_access) when not 'off'.
    Also treats legacy/converted falsy values ('0','false','no','') as off,
    in case INT columns were converted to VARCHAR ('0'/'1')."""
    s = str(value or "off").strip().lower()
    return s not in ("off", "0", "false", "no", "")


# ─────────────────────────────────────────────────────────────────────────────
# AUTH HELPERS  (mirror inventory_mgmt.py conventions)
# ─────────────────────────────────────────────────────────────────────────────

def _is_admin() -> bool:
    """Admin for inventory admin-tools = inventory edit-access. Matches
    inventory_mgmt._can_edit_inventory(): User_Type='admin' OR UID in
    {sonal, tarak}. Kept here as a standalone copy so this module has no
    import-time dependency on inventory_mgmt."""
    if not session.get("logged_in"):
        return False
    role = (session.get("User_Type") or "").strip().lower()
    uid = (session.get("UID") or "").strip().lower()
    return role == "admin" or uid in {"sonal", "tarak"}


def _user() -> str:
    # The access ROW is saved keyed to user_tbl.username (what the admin picker
    # sends). At login the username is typically in session['UID']; the display
    # name is in session['User_Name']. Prefer UID (username) so the read key
    # matches the saved key. Fall back to User_Name.
    return session.get("UID") or session.get("User_Name") or "Unknown"


def _user_candidates() -> list:
    """All identifiers this user might have their access row saved under, so the
    read matches regardless of whether it was keyed by username or display name."""
    cands = []
    for k in ("UID", "User_Name", "username", "user_name"):
        v = (session.get(k) or "").strip()
        if v and v not in cands:
            cands.append(v)
    return cands or ["Unknown"]


def _login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("logged_in"):
            # API routes want JSON; the modal calls these via fetch.
            if request.path.startswith("/api/"):
                return jsonify({"status": "error", "message": "Not logged in"}), 401
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return wrapper


def _admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("logged_in"):
            return jsonify({"status": "error", "message": "Not logged in"}), 401
        if not _is_admin():
            return jsonify({"status": "error", "message": "Admin only"}), 403
        return f(*args, **kwargs)
    return wrapper


# ─────────────────────────────────────────────────────────────────────────────
# TABLE INITIALISATION
# ─────────────────────────────────────────────────────────────────────────────

def _init_access_tables():
    conn = sampling_portal.get_db_connection()
    if not conn:
        print("[InventoryAccess] ⚠️  DB connection failed — init skipped.")
        return
    try:
        # Build the access columns dynamically from the category list. Each is
        # a short VARCHAR storing 'off' / 'on' / 'view' / 'edit'.
        col_defs = ",\n                ".join(
            f"`{c['key']}` VARCHAR(8) NOT NULL DEFAULT '{c['default']}'"
            for c in INV_ACCESS_CATEGORIES
        )

        # ── Per-user access row ──────────────────────────────────────────
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS inventory_user_access (
                user_name  VARCHAR(100) NOT NULL PRIMARY KEY,
                {col_defs},
                updated_at DATETIME     DEFAULT CURRENT_TIMESTAMP
                           ON UPDATE CURRENT_TIMESTAMP,
                updated_by VARCHAR(100) DEFAULT NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()

        # Idempotent column adds — covers installs created before a category
        # existed, and the migration from the previous TINYINT schema (old
        # columns are simply left unused; the new VARCHAR columns are added).
        for c in INV_ACCESS_CATEGORIES:
            ddl = f"`{c['key']}` VARCHAR(8) NOT NULL DEFAULT '{c['default']}'"
            for tbl in ("inventory_user_access", "inventory_access_groups"):
                try:
                    conn.execute(f"ALTER TABLE {tbl} ADD COLUMN {ddl}")
                    conn.commit()
                except Exception:
                    pass  # column already exists / table not yet created

        # ── Convert any legacy INT/TINYINT columns to VARCHAR(8) ─────────
        # Older installs created these toggle columns as INT, so saving the
        # string 'on'/'off' fails with "Incorrect integer value: 'on'".
        # MODIFY COLUMN is idempotent — converting a VARCHAR to VARCHAR is a
        # no-op, and integer 1/0 values cast cleanly to '1'/'0' which the
        # readers already treat as truthy/falsey.
        for c in INV_ACCESS_CATEGORIES:
            mod = f"MODIFY COLUMN `{c['key']}` VARCHAR(8) NOT NULL DEFAULT '{c['default']}'"
            for tbl in ("inventory_user_access", "inventory_access_groups"):
                try:
                    conn.execute(f"ALTER TABLE {tbl} {mod}")
                    conn.commit()
                except Exception:
                    pass  # table not yet created / already correct

        # ── Access GROUPS (additive layer over per-user access) ──────────
        conn.execute(f"""
            CREATE TABLE IF NOT EXISTS inventory_access_groups (
                group_id   INT AUTO_INCREMENT PRIMARY KEY,
                group_name VARCHAR(120) NOT NULL,
                {col_defs},
                note       VARCHAR(300) DEFAULT NULL,
                created_by VARCHAR(100) DEFAULT NULL,
                created_at DATETIME     DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME     DEFAULT CURRENT_TIMESTAMP
                           ON UPDATE CURRENT_TIMESTAMP,
                updated_by VARCHAR(100) DEFAULT NULL,
                UNIQUE KEY uq_inv_group_name (group_name)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()
        # Re-run the column adds now that the groups table definitely exists.
        for c in INV_ACCESS_CATEGORIES:
            ddl = f"`{c['key']}` VARCHAR(8) NOT NULL DEFAULT '{c['default']}'"
            try:
                conn.execute(f"ALTER TABLE inventory_access_groups ADD COLUMN {ddl}")
                conn.commit()
            except Exception:
                pass

        conn.execute("""
            CREATE TABLE IF NOT EXISTS inventory_access_group_members (
                user_name   VARCHAR(100) NOT NULL PRIMARY KEY,
                group_id    INT          NOT NULL,
                assigned_by VARCHAR(100) DEFAULT NULL,
                assigned_at DATETIME     DEFAULT CURRENT_TIMESTAMP,
                INDEX ix_inv_grpmem_group (group_id)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """)
        conn.commit()

        # ── Location lock (May 2026) ──
        # Pins a user to a single godown for material-movement flows:
        #   • New Material Request → destination forced to this godown
        #   • Fulfilling a Material Request via Material Out → source
        #     forced to this godown
        # NULL means "no lock" (admin behaviour — pick any godown).
        # Admins are never locked regardless of column value.
        try:
            conn.execute(
                "ALTER TABLE inventory_user_access "
                "ADD COLUMN locked_godown_id INT DEFAULT NULL"
            )
            conn.commit()
        except Exception:
            pass  # already exists

        print("✅ [InventoryAccess] access-control tables ready")
    except Exception:
        import traceback
        traceback.print_exc()
    finally:
        try:
            conn.close()
        except Exception:
            pass


# ─────────────────────────────────────────────────────────────────────────────
# ACCESS RESOLVERS  (importable by other inventory phases)
# ─────────────────────────────────────────────────────────────────────────────

def _defaults_dict():
    """Default access for a non-admin with no row: each category's configured
    default ('off' for most, 'view' for manage_godown)."""
    return {k: INV_ACCESS_DEFAULT[k] for k in INV_ACCESS_KEYS}


def _group_access_for_user(uname, conn):
    """Return the access dict from the user's assigned group, or None if the
    user isn't in any group (or on error). Lookup is case-insensitive on
    user_name so a row saved as 'Punam Singh' still matches a session UID
    of 'punam singh' or vice versa — same policy as the per-user row
    lookup in _inv_user_access_dict."""
    try:
        # Try exact match first (cheap), then case-insensitive.
        mem = conn.execute(
            "SELECT group_id FROM inventory_access_group_members "
            "WHERE user_name=%s LIMIT 1",
            (uname,),
        ).fetchone()
        if not mem:
            mem = conn.execute(
                "SELECT group_id FROM inventory_access_group_members "
                "WHERE LOWER(user_name)=LOWER(%s) LIMIT 1",
                (uname,),
            ).fetchone()
        if not mem:
            return None
        gid = mem["group_id"] if hasattr(mem, "get") else mem[0]
        existing = set()
        try:
            desc = conn.execute("SHOW COLUMNS FROM inventory_access_groups").fetchall()
            for c in desc:
                existing.add(c["Field"] if hasattr(c, "get") else c[0])
        except Exception:
            existing = set()
        sel_keys = [k for k in INV_ACCESS_KEYS if (not existing or k in existing)]
        if not sel_keys:
            return None
        cols = ", ".join(f"`{k}`" for k in sel_keys)
        grow = conn.execute(
            f"SELECT {cols} FROM inventory_access_groups WHERE group_id=%s LIMIT 1",
            (gid,),
        ).fetchone()
        if not grow:
            return None
        out = {}
        for k in INV_ACCESS_KEYS:
            if k not in sel_keys:
                out[k] = INV_ACCESS_DEFAULT[k]
                continue
            v = grow.get(k) if hasattr(grow, "get") else grow[k]
            out[k] = INV_ACCESS_DEFAULT[k] if v is None else _coerce_value(k, v)
        return out
    except Exception:
        return None


def _resolve_user_access(user=None, conn=None):
    """Single canonical access resolver. Returns a dict carrying both the
    access values AND diagnostic info about WHERE those values came from,
    so logs and the access modal can show "this user's rights came from
    group 'Stores Operators'" instead of just an opaque dict.

    Returns:
        {
            "is_admin":      bool,
            "source":        'admin' | 'row' | 'group' | 'defaults',
            "matched_name":  str | None,   # which user_candidates value matched
            "group_id":      int | None,   # when source='group'
            "access":        {key: 'off'|'on'|'view'|'edit', ...},
        }

    This is the function ALL gating decisions should ultimately go through.
    The older helpers (_inv_user_access_dict, _inv_user_has_access, etc.)
    are kept for backward compatibility but now delegate to this resolver.

    Performance note (May 2026):
    ---------------------------
    For the common case `_resolve_user_access()` (no args — "current user
    on this request") we cache the result on `flask.g`. Without this the
    inventory page-load path resolves access THREE times (page route,
    GRN caps, Opening caps) and every API route resolves it once more on
    top — for a non-admin user that's 3-4 DB connections and ~30+ queries
    per request hitting the MySQL server. With caching it's one connection,
    ~10 queries, once per request. The cache key includes the user identity
    so swapping sessions within the same request (unusual) still works.
    Pass an explicit `user=` to skip the cache (admin tools that resolve
    other users' access from inside one request).
    """
    # Per-request cache: only for the no-arg "current user" form. Explicit
    # user= or conn= calls always go through the full path (they're rare
    # and usually for admin tools that need a different user's data).
    _can_cache = (user is None and conn is None)
    if _can_cache:
        try:
            cached = getattr(g, '_inv_access_resolved', None)
            if cached is not None:
                return cached
        except RuntimeError:
            # Outside a Flask request context (e.g. invoked during app
            # boot). Skip the cache silently.
            _can_cache = False

    # Admins: short-circuit before any DB work.
    if user is None and _is_admin():
        result = {
            "is_admin":     True,
            "source":       "admin",
            "matched_name": _user(),
            "group_id":     None,
            "access":       {k: ("edit" if INV_ACCESS_KIND[k] == "level" else "on")
                             for k in INV_ACCESS_KEYS},
        }
        if _can_cache:
            try: g._inv_access_resolved = result
            except RuntimeError: pass
        return result

    uname = user if user is not None else _user()
    if not uname or uname == "Unknown":
        result = {
            "is_admin":     False,
            "source":       "defaults",
            "matched_name": None,
            "group_id":     None,
            "access":       _defaults_dict(),
        }
        if _can_cache:
            try: g._inv_access_resolved = result
            except RuntimeError: pass
        return result

    close_after = False
    if conn is None:
        conn = sampling_portal.get_db_connection()
        close_after = True
    try:
        # Column discovery — same as legacy path.
        existing = set()
        try:
            desc = conn.execute("SHOW COLUMNS FROM inventory_user_access").fetchall()
            for c in desc:
                existing.add(c["Field"] if hasattr(c, "get") else c[0])
        except Exception:
            existing = set()
        sel_keys = [k for k in INV_ACCESS_KEYS if (not existing or k in existing)]
        if not sel_keys:
            return {
                "is_admin": False, "source": "defaults",
                "matched_name": None, "group_id": None,
                "access": _defaults_dict(),
            }
        cols = ", ".join(f"`{k}`" for k in sel_keys)

        # Try every candidate identifier — both exact and case-insensitive.
        lookup_names = [user] if user is not None else _user_candidates()
        row = None
        matched = None
        for ln in lookup_names:
            row = conn.execute(
                f"SELECT {cols} FROM inventory_user_access WHERE user_name=%s LIMIT 1",
                (ln,),
            ).fetchone()
            if row:
                matched = ln
                break
            row = conn.execute(
                f"SELECT {cols} FROM inventory_user_access "
                f"WHERE LOWER(user_name)=LOWER(%s) LIMIT 1",
                (ln,),
            ).fetchone()
            if row:
                matched = ln
                break

        if row:
            access = {}
            for k in INV_ACCESS_KEYS:
                if k not in sel_keys:
                    access[k] = INV_ACCESS_DEFAULT[k]
                    continue
                v = row.get(k) if hasattr(row, "get") else row[k]
                access[k] = INV_ACCESS_DEFAULT[k] if v is None else _coerce_value(k, v)
            result = {
                "is_admin":     False,
                "source":       "row",
                "matched_name": matched,
                "group_id":     None,
                "access":       access,
            }
            if _can_cache:
                try: g._inv_access_resolved = result
                except RuntimeError: pass
            return result

        # No row → try group membership.
        for ln in lookup_names:
            grp_access = _group_access_for_user(ln, conn)
            if grp_access is not None:
                # Re-fetch group_id so we can report it
                gid = None
                try:
                    mr = conn.execute(
                        "SELECT group_id FROM inventory_access_group_members "
                        "WHERE user_name=%s OR LOWER(user_name)=LOWER(%s) LIMIT 1",
                        (ln, ln),
                    ).fetchone()
                    if mr:
                        gid = int(mr["group_id"] if hasattr(mr, "get") else mr[0])
                except Exception:
                    pass
                result = {
                    "is_admin":     False,
                    "source":       "group",
                    "matched_name": ln,
                    "group_id":     gid,
                    "access":       grp_access,
                }
                if _can_cache:
                    try: g._inv_access_resolved = result
                    except RuntimeError: pass
                return result

        result = {
            "is_admin":     False,
            "source":       "defaults",
            "matched_name": None,
            "group_id":     None,
            "access":       _defaults_dict(),
        }
        if _can_cache:
            try: g._inv_access_resolved = result
            except RuntimeError: pass
        return result
    except Exception:
        result = {
            "is_admin":     False,
            "source":       "defaults",
            "matched_name": None,
            "group_id":     None,
            "access":       _defaults_dict(),
        }
        if _can_cache:
            try: g._inv_access_resolved = result
            except RuntimeError: pass
        return result
    finally:
        if close_after:
            try:
                conn.close()
            except Exception:
                pass


def _inv_user_access_dict(user=None, conn=None):
    """Return {category: value} for the given user (or current user if None),
    where value is 'off' / 'on' / 'view' / 'edit'. Admins get full 'edit'/'on'.
    Non-admins with no row get the configured defaults (mostly 'off').

    Backward-compat wrapper around _resolve_user_access — returns just the
    access dict, dropping the diagnostic fields. New code should call
    _resolve_user_access directly to get source/matched_name/group_id info.
    """
    return _resolve_user_access(user=user, conn=conn).get("access") or _defaults_dict()


# Keep the original deep implementation around for any external callers
# that still import it by the underscore name. Internally we now delegate
# to _resolve_user_access — but the function body below is unreachable
# code preserved only as historical reference of the read logic. Safe to
# delete in a future cleanup pass once we're certain nothing external
# depends on a literal copy.
def _legacy_inv_user_access_dict_unused(user=None, conn=None):
    # Admins always have full access — short-circuit before the DB.
    if user is None and _is_admin():
        return {k: ("edit" if INV_ACCESS_KIND[k] == "level" else "on")
                for k in INV_ACCESS_KEYS}
    uname = user if user is not None else _user()
    if not uname or uname == "Unknown":
        return _defaults_dict()

    close_after = False
    if conn is None:
        conn = sampling_portal.get_db_connection()
        close_after = True
    try:
        # Only SELECT columns that actually exist — if a newly-added category
        # column hasn't been created on this DB yet (e.g. Flask not restarted
        # after adding it), querying it would raise "Unknown column" and we'd
        # wrongly fall back to all-defaults. Detect real columns first.
        existing = set()
        try:
            desc = conn.execute("SHOW COLUMNS FROM inventory_user_access").fetchall()
            for c in desc:
                existing.add(c["Field"] if hasattr(c, "get") else c[0])
        except Exception:
            existing = set()
        sel_keys = [k for k in INV_ACCESS_KEYS if (not existing or k in existing)]
        if not sel_keys:
            return _defaults_dict()
        cols = ", ".join(f"`{k}`" for k in sel_keys)

        # When reading the CURRENT user (user is None), the access row may have
        # been saved under any of several identifiers (UID/username vs display
        # User_Name). Try each candidate until we find a row.
        lookup_names = [user] if user is not None else _user_candidates()
        row = None
        for ln in lookup_names:
            # Try exact match first, then case-insensitive — catches identifier
            # casing mismatches (e.g. row saved as "Ashish Makwana" but session
            # UID is "ashish makwana").
            row = conn.execute(
                f"SELECT {cols} FROM inventory_user_access WHERE user_name=%s LIMIT 1",
                (ln,),
            ).fetchone()
            if row:
                break
            row = conn.execute(
                f"SELECT {cols} FROM inventory_user_access WHERE LOWER(user_name)=LOWER(%s) LIMIT 1",
                (ln,),
            ).fetchone()
            if row:
                break
        if not row:
            # No explicit per-user row → fall back to the user's GROUP access
            # if they belong to one, else defaults.
            for ln in lookup_names:
                grp = _group_access_for_user(ln, conn)
                if grp is not None:
                    return grp
            return _defaults_dict()
        out = {}
        for k in INV_ACCESS_KEYS:
            if k not in sel_keys:
                out[k] = INV_ACCESS_DEFAULT[k]   # column missing → default
                continue
            v = row.get(k) if hasattr(row, "get") else row[k]
            out[k] = INV_ACCESS_DEFAULT[k] if v is None else _coerce_value(k, v)
        return out
    except Exception:
        return _defaults_dict()
    finally:
        if close_after:
            try:
                conn.close()
            except Exception:
                pass


def _inv_access_level(category, user=None, conn=None):
    """Return the raw level string ('off'/'on'/'view'/'edit') for a category.
    Admins get 'edit' (level) or 'on' (boolean)."""
    if category not in INV_ACCESS_KEYS:
        return "edit"
    if user is None and _is_admin():
        return "edit" if INV_ACCESS_KIND.get(category) == "level" else "on"
    d = _inv_user_access_dict(user=user, conn=conn)
    return d.get(category, INV_ACCESS_DEFAULT.get(category, "off"))


def _inv_can_edit(category, user=None, conn=None):
    """For 'level' categories: True only when the value is 'edit'. For boolean
    categories: True when enabled. Admins always True."""
    if user is None and _is_admin():
        return True
    lvl = _inv_access_level(category, user=user, conn=conn)
    if INV_ACCESS_KIND.get(category) == "level":
        return lvl == "edit"
    return _is_enabled(lvl)


# ── GRN / Opening Stock capability helpers ───────────────────────────────────
# These encode the View/Print-only restriction so route guards stay readable.
#
#   GRN:
#     can_view_grn   = grn on
#     can_edit_grn   = grn on AND grn_edit on AND grn_view_print OFF
#     can_create_grn = grn on AND grn_new  on AND grn_view_print OFF
#     can_delete_grn = same as edit (delete is an edit-class action)
#
#   Opening Stock:
#     can_view_opening = opening_stock on
#     can_edit_opening = opening_stock on AND opening_stock_view_print OFF
#   (Opening Stock has no separate new/edit toggle — the view_print switch is
#    the only restriction layer over the base opening_stock permission.)

def _inv_grn_caps(user=None, conn=None):
    """Return {'view','print','edit','create','delete'} booleans for GRN."""
    if user is None and _is_admin():
        return {k: True for k in ("view", "print", "edit", "create", "delete")}
    d = _inv_user_access_dict(user=user, conn=conn)
    locked    = _is_enabled(d.get("view_only", "off"))   # master read-only
    on        = _is_enabled(d.get("grn", "off"))
    view_only = _is_enabled(d.get("grn_view_print", "off")) or locked
    can_edit  = on and _is_enabled(d.get("grn_edit", "off")) and not view_only
    can_new   = on and _is_enabled(d.get("grn_new", "off")) and not view_only
    return {
        "view":   on,
        "print":  on,            # any GRN access can print
        "edit":   can_edit,
        "create": can_new,
        "delete": can_edit,      # delete is an edit-class action
    }


def _inv_items_caps(user=None, conn=None):
    """Return {'view','edit'} booleans for the Items (RM master) grid.
    'items' is a LEVEL cap: off / view / edit. Admins get full edit. Under the
    master view_only lock a non-admin is capped at 'view' (never edit)."""
    if user is None and _is_admin():
        return {"view": True, "edit": True}
    d = _inv_user_access_dict(user=user, conn=conn)
    lvl    = str(d.get("items", INV_ACCESS_DEFAULT.get("items", "off"))).lower()
    locked = _is_enabled(d.get("view_only", "off"))   # master read-only
    view   = lvl in ("view", "edit", "on")
    edit   = (lvl == "edit") and not locked
    return {"view": view, "edit": edit}


def _inv_opening_caps(user=None, conn=None):
    """Return {'view','print','edit'} booleans for Opening Stock."""
    if user is None and _is_admin():
        return {k: True for k in ("view", "print", "edit")}
    d = _inv_user_access_dict(user=user, conn=conn)
    locked    = _is_enabled(d.get("view_only", "off"))   # master read-only
    on        = _is_enabled(d.get("opening_stock", "off"))
    view_only = _is_enabled(d.get("opening_stock_view_print", "off")) or locked
    return {
        "view":  on,
        "print": on,
        "edit":  on and not view_only,
    }


def _inv_block_grn_edit():
    """Route guard: block when the current user can't edit/delete a GRN."""
    if _inv_grn_caps().get("edit"):
        return None
    uname = _user() or "Unknown"
    return (jsonify({
        "status": "error", "code": "access_denied", "category": "grn_edit",
        "user_name": uname,
        "message": f'Access denied for "{uname}": GRN is view/print-only — editing or deleting is not permitted.',
    }), 403)


def _inv_block_opening_edit():
    """Route guard: block when the current user can't create/edit Opening Stock."""
    if _inv_opening_caps().get("edit"):
        return None
    uname = _user() or "Unknown"
    return (jsonify({
        "status": "error", "code": "access_denied", "category": "opening_stock",
        "user_name": uname,
        "message": f'Access denied for "{uname}": Opening Stock is view/print-only — creating or editing is not permitted.',
    }), 403)


def _inv_user_has_access(category, user=None, conn=None):
    """Check a single category for the current (or named) user. Admins always
    pass. Unknown category strings always return True (defensive)."""
    if category not in INV_ACCESS_KEYS:
        return True
    if user is None and _is_admin():
        return True
    d = _inv_user_access_dict(user=user, conn=conn)
    # View-only lock: if enabled, deny every ACTION capability (anything not in
    # the view-allowed set). This is the authoritative server-side guard — the
    # frontend mirrors it for UX, but blocking here is what actually protects
    # the data even if the UI is bypassed.
    if _is_enabled(d.get("view_only", "off")) and category not in INV_VIEW_ONLY_ALLOWED:
        return False
    return _is_enabled(d.get(category, INV_ACCESS_DEFAULT.get(category, "off")))


def _inv_block_if_no_access(category):
    """Return a (jsonify, status) tuple to short-circuit a route when the
    current user lacks access to `category`. None when allowed.

    Usage in any inventory route:
        blocked = _inv_block_if_no_access('material_request')
        if blocked is not None: return blocked
    """
    try:
        if _inv_user_has_access(category):
            return None
    except Exception:
        return None  # fail-open on lookup errors
    nice = INV_ACCESS_NICE.get(category, category.replace("_", " ").title())
    uname = _user() or "Unknown"
    return (jsonify({
        "status":    "error",
        "code":      "access_denied",
        "category":  category,
        "user_name": uname,
        "message": (
            f'Access denied for "{uname}": no permission for "{nice}". '
            f"Ask an admin to grant access in the User Access Control modal."
        ),
    }), 403)


# ─────────────────────────────────────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────────────────────────────────────

def _locked_godown_id(user=None, conn=None):
    """Return the godown id this user is pinned to, or None.
    Admins always return None — they're never location-locked.
    Uses the cache where possible (this is hit on every API call that
    needs to honour the lock)."""
    # Per-request memoization. Avoid 5+ identical queries per request
    # for the same user.
    if user is None:
        try:
            cached = getattr(g, '_inv_locked_godown', None)
            if cached is not None:
                # Sentinel '_NONE_' means we already resolved to None
                return None if cached == '_NONE_' else cached
        except RuntimeError:
            pass

    if user is None and _is_admin():
        try: g._inv_locked_godown = '_NONE_'
        except RuntimeError: pass
        return None

    close_after = False
    if conn is None:
        try:
            conn = sampling_portal.get_db_connection()
            close_after = True
        except Exception:
            return None
    try:
        lookup_names = [user] if user is not None else _user_candidates()
        for ln in lookup_names:
            try:
                row = conn.execute(
                    "SELECT locked_godown_id FROM inventory_user_access "
                    "WHERE user_name=%s OR LOWER(user_name)=LOWER(%s) LIMIT 1",
                    (ln, ln)
                ).fetchone()
            except Exception:
                # Column doesn't exist yet on this install → no lock.
                row = None
            if row:
                gid = row.get("locked_godown_id") if hasattr(row, "get") else row[0]
                if gid:
                    try: gid = int(gid)
                    except Exception: pass
                    if user is None:
                        try: g._inv_locked_godown = gid
                        except RuntimeError: pass
                    return gid
        if user is None:
            try: g._inv_locked_godown = '_NONE_'
            except RuntimeError: pass
        return None
    finally:
        if close_after:
            try: conn.close()
            except Exception: pass


def register_inventory_access(app):
    """Register all User Access Control routes + bootstrap tables.

    Idempotent: if the routes are already registered (e.g. auto-registered
    from register_inventory_mgmt AND also called directly in app.py), this
    returns early instead of letting Flask raise a duplicate-endpoint error.
    """
    if getattr(app, "_inventory_access_registered", False):
        return
    app._inventory_access_registered = True
    _init_access_tables()

    # ── Candidate user list (from user_tbl) ──────────────────────────────
    @app.route("/api/inventory_mgmt/access/users", methods=["GET"])
    @_admin_required
    def api_inv_access_users():
        """List candidate usernames from user_tbl so the picker can offer
        every system user, merged with anyone who already has a custom row.

        Resilient to schema variation: tries the full SELECT first, then a
        minimal fallback (just username). Surfaces the real error in a
        `debug` field so a silent empty list never hides a query problem.
        """
        import sys

        def _rowval(r, key, idx):
            """dict-or-tuple safe accessor."""
            try:
                if hasattr(r, "get"):
                    return r.get(key)
                if isinstance(r, dict):
                    return r.get(key)
                return r[key]            # mapping-style row by key
            except Exception:
                try:
                    return r[idx]        # positional fallback
                except Exception:
                    return None

        conn = sampling_portal.get_db_connection()
        debug = None
        try:
            users = []
            # Try multiple table-name casings — MySQL case-sensitivity depends on
            # lower_case_table_names and OS (case-sensitive on Linux by default,
            # insensitive on Windows). The actual table is `User_Tbl`; older
            # references used `user_tbl`. We try both so this works either way.
            user_tbl_candidates = ["User_Tbl", "user_tbl", "USER_TBL"]
            full_select_tpl = """
                SELECT username                       AS user_name,
                       COALESCE(full_name, username)  AS display_name,
                       COALESCE(`role`, '')           AS role,
                       COALESCE(user_type, '')        AS user_type,
                       COALESCE(department, '')       AS department,
                       COALESCE(designation, '')      AS designation,
                       COALESCE(is_active, 1)         AS is_active
                FROM {tbl}
                ORDER BY COALESCE(is_active,1) DESC, username
            """
            rows = None
            used_tbl = None
            last_err = None
            for tbl in user_tbl_candidates:
                try:
                    rows = conn.execute(full_select_tpl.format(tbl=tbl)).fetchall()
                    used_tbl = tbl
                    break
                except Exception as e1:
                    last_err = e1
            if rows is None:
                debug = f"full-select failed on all casings; last err: {last_err}"
                print(f"[InventoryAccess] {debug}", file=sys.stderr)
                # ── Fallback: minimal — just username, no optional cols ──
                for tbl in user_tbl_candidates:
                    try:
                        rows = conn.execute(
                            "SELECT username FROM {tbl} ORDER BY username".format(tbl=tbl)
                        ).fetchall()
                        used_tbl = tbl
                        for r in rows:
                            un = _rowval(r, "username", 0)
                            if un:
                                users.append({
                                    "user_name": un, "display_name": un,
                                    "role": "", "user_type": "",
                                    "department": "", "designation": "",
                                    "is_active": 1,
                                })
                        debug = (debug or "") + f" | minimal-select succeeded on {tbl}"
                        break
                    except Exception as e2:
                        last_err = e2
                if not users:
                    debug = (debug or "") + f" | minimal-select failed on all casings; last err: {last_err}"
                    print(f"[InventoryAccess] {debug}", file=sys.stderr)
            else:
                # full-select succeeded — build user records
                for r in rows:
                    un = _rowval(r, "user_name", 0)
                    if not un:
                        continue
                    users.append({
                        "user_name":    un,
                        "display_name": _rowval(r, "display_name", 1) or un,
                        "role":         _rowval(r, "role", 2) or "",
                        "user_type":    _rowval(r, "user_type", 3) or "",
                        "department":   _rowval(r, "department", 4) or "",
                        "designation":  _rowval(r, "designation", 5) or "",
                        "is_active":    int(_rowval(r, "is_active", 6) or 0),
                    })
                debug = f"full-select succeeded on {used_tbl} ({len(users)} users)"
                print(f"[InventoryAccess] {debug}")

            # ── Merge in anyone who already has a custom access row ──
            existing = []
            try:
                ex_rows = conn.execute(
                    "SELECT user_name FROM inventory_user_access ORDER BY user_name"
                ).fetchall()
                existing = [_rowval(r, "user_name", 0) for r in ex_rows]
                existing = [u for u in existing if u]
            except Exception:
                pass

            seen, merged = set(), []
            for u in users:
                if u["user_name"] not in seen:
                    seen.add(u["user_name"])
                    merged.append(u)
            for un in existing:
                if un not in seen:
                    seen.add(un)
                    merged.append({
                        "user_name": un, "display_name": un,
                        "role": "", "user_type": "",
                        "department": "", "designation": "",
                        "is_active": 1,
                    })

            conn.close()
            resp = {"status": "ok", "users": merged, "count": len(merged)}
            if debug:
                resp["debug"] = debug.strip(" |")
            return jsonify(resp)
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e),
                            "debug": debug}), 500

    # ── List every customised row ─────────────────────────────────────────
    @app.route("/api/inventory_mgmt/access/list", methods=["GET"])
    @_admin_required
    def api_inv_access_list():
        conn = sampling_portal.get_db_connection()
        try:
            cols = ", ".join(f"`{k}`" for k in INV_ACCESS_KEYS)
            rows = conn.execute(
                f"""SELECT user_name, {cols},
                           updated_at, COALESCE(updated_by,'') AS updated_by
                    FROM inventory_user_access
                    ORDER BY user_name"""
            ).fetchall()
            conn.close()
            out = []
            for r in rows:
                d = dict(r)
                if d.get("updated_at") is not None:
                    d["updated_at"] = str(d["updated_at"])
                for k in INV_ACCESS_KEYS:
                    v = d.get(k)
                    d[k] = INV_ACCESS_DEFAULT[k] if v is None else _coerce_value(k, v)
                out.append(d)
            return jsonify({
                "status": "ok",
                "keys":   list(INV_ACCESS_KEYS),
                "rows":   out,
            })
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Get one user's access ─────────────────────────────────────────────
    @app.route("/api/inventory_mgmt/access/user/<path:user_name>", methods=["GET"])
    @_admin_required
    def api_inv_access_get(user_name):
        user_name = (user_name or "").strip()
        if not user_name:
            return jsonify({"status": "error", "message": "user_name required"}), 400
        try:
            access = _inv_user_access_dict(user=user_name)
            # Also read the location lock so the modal can pre-fill the
            # picker. Quiet-fail if the column isn't present on this install.
            locked_id = None
            try:
                conn = sampling_portal.get_db_connection()
                try:
                    row = conn.execute(
                        "SELECT locked_godown_id FROM inventory_user_access "
                        "WHERE user_name=%s OR LOWER(user_name)=LOWER(%s) LIMIT 1",
                        (user_name, user_name)
                    ).fetchone()
                    if row:
                        locked_id = row.get("locked_godown_id") if hasattr(row, "get") else row[0]
                finally:
                    try: conn.close()
                    except Exception: pass
            except Exception:
                pass
            return jsonify({
                "status":           "ok",
                "user_name":        user_name,
                "access":           access,
                "locked_godown_id": locked_id,
            })
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Save one user's access (partial UPSERT) ───────────────────────────
    @app.route("/api/inventory_mgmt/access/save", methods=["POST"])
    @_admin_required
    def api_inv_access_save():
        d = request.get_json(silent=True) or {}
        user_name = (d.get("user_name") or "").strip()
        access = d.get("access") or {}
        if not user_name:
            return jsonify({"status": "error", "message": "user_name required"}), 400
        if not isinstance(access, dict):
            return jsonify({"status": "error", "message": "access must be a dict"}), 400

        clean = {k: _coerce_value(k, access[k]) for k in INV_ACCESS_KEYS if k in access}
        if not clean:
            return jsonify({"status": "error", "message": "No valid keys in access dict"}), 400

        conn = sampling_portal.get_db_connection()
        try:
            # Detect actual columns + types so we (a) only write columns that
            # exist on this DB, and (b) write the right value type (INT vs
            # VARCHAR) even if the legacy migration hasn't run yet.
            int_cols = set()
            existing_cols = set()
            try:
                desc = conn.execute("SHOW COLUMNS FROM inventory_user_access").fetchall()
                for col in desc:
                    cname = (col["Field"] if hasattr(col, "get") else col[0])
                    ctype = (col["Type"]  if hasattr(col, "get") else col[1]) or ""
                    existing_cols.add(cname)
                    if "int" in str(ctype).lower():
                        int_cols.add(cname)
            except Exception:
                pass

            # If the table is somehow missing category columns (e.g. Flask not
            # restarted after a new category was added), try to add them now so
            # the save doesn't fail with "Unknown column".
            for k in INV_ACCESS_KEYS:
                if existing_cols and k not in existing_cols:
                    try:
                        dflt = INV_ACCESS_DEFAULT.get(k, "off")
                        conn.execute(
                            f"ALTER TABLE inventory_user_access ADD COLUMN `{k}` VARCHAR(8) NOT NULL DEFAULT '{dflt}'"
                        )
                        conn.commit()
                        existing_cols.add(k)
                    except Exception:
                        pass  # couldn't add; we'll just skip it below

            def _val_for(col, level_str):
                """level_str is 'on'/'off'/'view'/'edit'. Convert to the column's
                storage type: INT columns get 1/0, VARCHAR columns get the string."""
                if col in int_cols:
                    return 0 if str(level_str).lower() in ("off", "0", "false", "no", "") else 1
                return level_str

            # Only operate on columns that actually exist on this table.
            usable = [k for k in INV_ACCESS_KEYS if (not existing_cols or k in existing_cols)]
            insert_cols = ["user_name"] + [f"`{k}`" for k in usable] + ["updated_by"]
            insert_vals = [user_name]
            for k in usable:
                raw = clean[k] if k in clean else INV_ACCESS_DEFAULT[k]
                insert_vals.append(_val_for(k, raw))
            insert_vals.append(_user())
            update_clauses = [f"`{k}`=VALUES(`{k}`)" for k in clean.keys() if (not existing_cols or k in existing_cols)]
            update_clauses.append("updated_by=VALUES(updated_by)")
            sql = (
                f"INSERT INTO inventory_user_access ({', '.join(insert_cols)}) "
                f"VALUES ({', '.join(['%s'] * len(insert_vals))}) "
                f"ON DUPLICATE KEY UPDATE {', '.join(update_clauses)}"
            )
            conn.execute(sql, insert_vals)
            conn.commit()

            # ── Location lock (May 2026) ──
            # locked_godown_id is a separate field on the access row (not
            # one of the INV_ACCESS_KEYS toggles), so we update it in a
            # second statement. The column is added by an idempotent
            # ALTER in _init_access_tables, but on installs that haven't
            # been restarted since the migration this UPDATE will fail —
            # we swallow that quietly so an old build doesn't break the
            # rest of the save.
            if "locked_godown_id" in d:
                try:
                    raw_gid = d.get("locked_godown_id")
                    gid_val = None
                    if raw_gid not in (None, "", 0, "0"):
                        try: gid_val = int(raw_gid)
                        except Exception: gid_val = None
                    conn.execute(
                        "UPDATE inventory_user_access SET locked_godown_id=%s "
                        "WHERE user_name=%s",
                        (gid_val, user_name)
                    )
                    conn.commit()
                except Exception:
                    import traceback; traceback.print_exc()

            new_access = _inv_user_access_dict(user=user_name, conn=conn)
            # Read back the lock so the client can verify what landed.
            new_lock = None
            try:
                row = conn.execute(
                    "SELECT locked_godown_id FROM inventory_user_access WHERE user_name=%s",
                    (user_name,)
                ).fetchone()
                if row:
                    new_lock = row.get("locked_godown_id") if hasattr(row, "get") else row[0]
            except Exception:
                pass
            conn.close()
            return jsonify({
                "status": "ok", "user_name": user_name, "access": new_access,
                "locked_godown_id": new_lock,
            })
        except Exception as e:
            import traceback
            traceback.print_exc()
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── Delete one user's row (reset to defaults) ─────────────────────────
    @app.route("/api/inventory_mgmt/access/delete", methods=["POST"])
    @_admin_required
    def api_inv_access_delete():
        d = request.get_json(silent=True) or {}
        user_name = (d.get("user_name") or "").strip()
        if not user_name:
            return jsonify({"status": "error", "message": "user_name required"}), 400
        conn = sampling_portal.get_db_connection()
        try:
            conn.execute(
                "DELETE FROM inventory_user_access WHERE user_name=%s",
                (user_name,),
            )
            conn.commit()
            conn.close()
            return jsonify({"status": "ok", "user_name": user_name, "reset": True})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    # ── "My access" — any logged-in user can read their own flags ─────────
    # Used by the frontend to gate the UI for the current (non-admin) user.
    @app.route("/api/inventory_mgmt/access/me", methods=["GET"])
    @_login_required
    def api_inv_access_me():
        """Return the current user's resolved access plus diagnostic info:
        which session identifiers exist, where the rights came from (row /
        group / defaults), and which identifier matched. This is what the
        frontend bootstraps `window._invAccess` from."""
        try:
            resolved = _resolve_user_access()
            # Resolve locked godown (None for admins). Also look up the
            # display name so the UI can show 'Locked to FACTORY' etc.
            locked_id   = None
            locked_name = None
            try:
                if not resolved.get("is_admin"):
                    locked_id = _locked_godown_id()
                    if locked_id:
                        conn = sampling_portal.get_db_connection()
                        try:
                            row = conn.execute(
                                "SELECT name FROM procurement_godowns WHERE id=%s",
                                (locked_id,)
                            ).fetchone()
                            if row:
                                locked_name = row.get("name") if hasattr(row, "get") else row[0]
                        finally:
                            try: conn.close()
                            except Exception: pass
            except Exception:
                pass

            return jsonify({
                "status":       "ok",
                "user_name":    _user(),
                "is_admin":     resolved.get("is_admin", False),
                "access":       resolved.get("access") or _defaults_dict(),
                "keys":         list(INV_ACCESS_KEYS),
                # Diagnostic fields — surfaced in [InventoryAccess] console
                # log and helpful when a user reports "I have the toggle on
                # but it's not working".
                "source":       resolved.get("source", "defaults"),
                "matched_name": resolved.get("matched_name"),
                "group_id":     resolved.get("group_id"),
                "candidates":   _user_candidates(),
                # Location lock — used by Material Request to force destination
                # to the user's pinned godown, and by Stock Transfer to force
                # source on fulfilment. NULL for admins or unconfigured users.
                "locked_godown_id":   locked_id,
                "locked_godown_name": locked_name,
            })
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500

    # ═══════════════════ ACCESS GROUPS ═══════════════════════════════════
    @app.route("/api/inventory_mgmt/access/groups", methods=["GET"])
    @_admin_required
    def api_inv_groups_list():
        conn = sampling_portal.get_db_connection()
        try:
            cols = ", ".join(f"`{k}`" for k in INV_ACCESS_KEYS)
            rows = conn.execute(
                f"""SELECT group_id, group_name, {cols},
                           COALESCE(note,'') AS note,
                           updated_at, COALESCE(updated_by,'') AS updated_by
                    FROM inventory_access_groups
                    ORDER BY group_name"""
            ).fetchall()
            # member counts
            counts = {}
            try:
                crows = conn.execute(
                    "SELECT group_id, COUNT(*) AS n "
                    "FROM inventory_access_group_members GROUP BY group_id"
                ).fetchall()
                for cr in crows:
                    counts[cr["group_id"] if hasattr(cr, "get") else cr[0]] = (
                        cr["n"] if hasattr(cr, "get") else cr[1]
                    )
            except Exception:
                pass
            conn.close()
            out = []
            for r in rows:
                d = dict(r)
                if d.get("updated_at") is not None:
                    d["updated_at"] = str(d["updated_at"])
                for k in INV_ACCESS_KEYS:
                    v = d.get(k)
                    d[k] = INV_ACCESS_DEFAULT[k] if v is None else _coerce_value(k, v)
                d["member_count"] = counts.get(d["group_id"], 0)
                out.append(d)
            return jsonify({
                "status": "ok", "keys": list(INV_ACCESS_KEYS), "groups": out
            })
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/inventory_mgmt/access/groups/save", methods=["POST"])
    @_admin_required
    def api_inv_groups_save():
        d = request.get_json(silent=True) or {}
        group_id = d.get("group_id")
        group_name = (d.get("group_name") or "").strip()
        note = (d.get("note") or "").strip() or None
        access = d.get("access") or {}
        if not group_name:
            return jsonify({"status": "error", "message": "group_name required"}), 400
        if not isinstance(access, dict):
            return jsonify({"status": "error", "message": "access must be a dict"}), 400

        conn = sampling_portal.get_db_connection()
        try:
            vals = {}
            for k in INV_ACCESS_KEYS:
                if k in access:
                    vals[k] = _coerce_value(k, access[k])
                else:
                    vals[k] = INV_ACCESS_DEFAULT[k]
            if group_id:
                set_clause = ", ".join([f"`{k}`=%s" for k in INV_ACCESS_KEYS])
                params = [vals[k] for k in INV_ACCESS_KEYS] + [
                    group_name, note, _user(), int(group_id)
                ]
                conn.execute(
                    f"UPDATE inventory_access_groups SET {set_clause}, "
                    f"group_name=%s, note=%s, updated_by=%s WHERE group_id=%s",
                    params,
                )
                conn.commit()
                gid = int(group_id)
            else:
                cols = [f"`{k}`" for k in INV_ACCESS_KEYS] + ["group_name", "note", "created_by", "updated_by"]
                params = [vals[k] for k in INV_ACCESS_KEYS] + [
                    group_name, note, _user(), _user()
                ]
                conn.execute(
                    f"INSERT INTO inventory_access_groups ({', '.join(cols)}) "
                    f"VALUES ({', '.join(['%s'] * len(params))})",
                    params,
                )
                conn.commit()
                gid = conn.execute("SELECT LAST_INSERT_ID() AS i").fetchone()
                gid = (gid["i"] if hasattr(gid, "get") else gid[0])
            conn.close()
            return jsonify({"status": "ok", "group_id": gid})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/inventory_mgmt/access/groups/<int:group_id>", methods=["DELETE"])
    @_admin_required
    def api_inv_groups_delete(group_id):
        conn = sampling_portal.get_db_connection()
        try:
            conn.execute(
                "DELETE FROM inventory_access_group_members WHERE group_id=%s",
                (group_id,),
            )
            conn.execute(
                "DELETE FROM inventory_access_groups WHERE group_id=%s",
                (group_id,),
            )
            conn.commit()
            conn.close()
            return jsonify({"status": "ok", "deleted": group_id})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/inventory_mgmt/access/groups/<int:group_id>/members", methods=["GET"])
    @_admin_required
    def api_inv_groups_members(group_id):
        conn = sampling_portal.get_db_connection()
        try:
            rows = conn.execute(
                "SELECT user_name, COALESCE(assigned_by,'') AS assigned_by, "
                "assigned_at FROM inventory_access_group_members "
                "WHERE group_id=%s ORDER BY user_name",
                (group_id,),
            ).fetchall()
            conn.close()
            out = []
            for r in rows:
                d = dict(r)
                if d.get("assigned_at") is not None:
                    d["assigned_at"] = str(d["assigned_at"])
                out.append(d)
            return jsonify({"status": "ok", "group_id": group_id, "members": out})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    @app.route("/api/inventory_mgmt/access/groups/assign", methods=["POST"])
    @_admin_required
    def api_inv_groups_assign():
        d = request.get_json(silent=True) or {}
        user_name = (d.get("user_name") or "").strip()
        group_id = d.get("group_id")
        if not user_name:
            return jsonify({"status": "error", "message": "user_name required"}), 400
        conn = sampling_portal.get_db_connection()
        try:
            if group_id in (None, "", 0, "0"):
                # Unassign from any group.
                conn.execute(
                    "DELETE FROM inventory_access_group_members WHERE user_name=%s",
                    (user_name,),
                )
            else:
                conn.execute(
                    "INSERT INTO inventory_access_group_members "
                    "(user_name, group_id, assigned_by) VALUES (%s, %s, %s) "
                    "ON DUPLICATE KEY UPDATE group_id=VALUES(group_id), "
                    "assigned_by=VALUES(assigned_by), assigned_at=CURRENT_TIMESTAMP",
                    (user_name, int(group_id), _user()),
                )
            conn.commit()
            conn.close()
            return jsonify({"status": "ok", "user_name": user_name, "group_id": group_id})
        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return jsonify({"status": "error", "message": str(e)}), 500

    print("✅ [InventoryAccess] routes registered (/api/inventory_mgmt/access/*)")
