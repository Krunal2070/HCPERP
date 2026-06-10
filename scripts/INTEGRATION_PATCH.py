"""
HCP Stock — Integration Notes
===============================================================================
This module is a Flask blueprint that bolts onto your existing portal app.py.
Restricted to admin & planning users.

FILES TO COPY INTO YOUR PROJECT
-------------------------------------------------------------------------------
    hcp_stock_db.py          → next to app.py
    hcp_stock_routes.py      → next to app.py
    templates/hcp_stock.html → into your existing /templates folder
    templates/index.html     → REPLACES yours (adds the HCP Stock KPI tile,
                               role-gated to admin/planning only)

The patched app.py shipped here already has the four wiring lines below.
If you ever start from a fresh app.py, add these:

    # near the top, after `import sampling_portal`
    from hcp_stock_routes import hcp_stock_bp        # HCP Stock blueprint
    import hcp_stock_db                              # HCP Stock DB bootstrap

    # right after `app = Flask(...)` and your other blueprint registrations
    app.register_blueprint(hcp_stock_bp)
    hcp_stock_db.ensure_tables()


DATA MODEL
-------------------------------------------------------------------------------
    procurement_brands (existing — read-only here)

    hcp_stock_pm                Packing Material master
        brand_id (FK procurement_brands), pm_code, pm_name, pm_type,
        sku_size, rate, opening_stock, provisional_wastage

    hcp_stock_fg                Finished Good (Product) master
        brand_id, product_code, product_name, category, sku_size, rate
        (no opening / closing — only a dispatch register)

    hcp_stock_bom               BOM linking FG → list of PMs
        fg_id, pm_id, qty_per_unit (UNIQUE on fg_id+pm_id)

    hcp_stock_inward            PM inward
    hcp_stock_wastage           PM actual wastage
    hcp_stock_dispatch          FG dispatch
    hcp_stock_dispatch_consume  audit snapshot of BOM at dispatch time


KEY BUSINESS RULES
-------------------------------------------------------------------------------
1. Brands are READ-ONLY — sourced from the existing `procurement_brands` table.
   No seed data is created by this module.

2. Dispatching an FG AUTO-CONSUMES PMs per its BOM:
     consumption[pm] = bom.qty_per_unit × dispatch.quantity

3. If consumption would push any PM closing stock NEGATIVE, the dispatch is
   blocked atomically (HTTP 409 + JSON shortage list). Nothing is written.

4. UPDATE dispatch re-validates against current PM levels (excluding the
   dispatch's own existing consumption). DELETE dispatch reverses consumption
   automatically via FK CASCADE on hcp_stock_dispatch_consume.

5. PM closing stock formula:
     closing = opening + Σ inward − Σ BOM consumption − Σ actual wastage

6. FG has no closing stock. Its register is the dispatch table only.


URL MAP
-------------------------------------------------------------------------------
    GET  /hcp_stock/                              page
    GET  /hcp_stock/api/brands                    list brands

    GET  /hcp_stock/api/pm                        list PMs (incl. KPI block)
    POST /hcp_stock/api/pm                        create PM
    PUT  /hcp_stock/api/pm/<id>                   update PM
    DEL  /hcp_stock/api/pm/<id>                   delete PM

    GET  /hcp_stock/api/fg                        list FGs
    POST /hcp_stock/api/fg                        create FG (+ optional bom)
    PUT  /hcp_stock/api/fg/<id>                   update FG
    DEL  /hcp_stock/api/fg/<id>                   delete FG
    GET  /hcp_stock/api/fg/<id>/bom               read BOM
    PUT  /hcp_stock/api/fg/<id>/bom               replace BOM

    GET  /hcp_stock/api/inward                    list PM inward
    POST /hcp_stock/api/inward                    create
    PUT  /hcp_stock/api/inward/<id>               update
    DEL  /hcp_stock/api/inward/<id>               delete

    GET  /hcp_stock/api/dispatch                  list FG dispatch
    POST /hcp_stock/api/dispatch                  create  (409 on shortage)
    PUT  /hcp_stock/api/dispatch/<id>             update  (409 on shortage)
    DEL  /hcp_stock/api/dispatch/<id>             delete  (reverses consume)
    GET  /hcp_stock/api/dispatch/<id>/consumption per-dispatch PM breakdown

    GET  /hcp_stock/api/wastage                   list PM wastage
    POST /hcp_stock/api/wastage                   create
    PUT  /hcp_stock/api/wastage/<id>              update
    DEL  /hcp_stock/api/wastage/<id>              delete

    GET  /hcp_stock/template/download             Excel import template
    POST /hcp_stock/import                        bulk import PM + FG
    GET  /hcp_stock/export                        full multi-sheet export


AUTH / ROLE GATE
-------------------------------------------------------------------------------
    All routes require:
        session['logged_in']        — set by your normal login
        session['User_Type'] in {'admin', 'planning'}  (case-insensitive)

    The home page tile in templates/index.html is also role-gated using
    Jinja conditionals so non-allowed roles never see it.

    On role failure:
        - HTML routes return 403 with a friendly "Access denied" page
        - API routes return 403 JSON: {"ok": false, "error": "..."}


DEPENDENCIES
-------------------------------------------------------------------------------
    flask, openpyxl    — already in your project (used elsewhere)
    sampling_portal    — your existing DB wrapper
    procurement_brands table must exist (it already does — see app.py:4823)


VERIFIED
-------------------------------------------------------------------------------
    ✓ Schema creates cleanly on MariaDB 10.11 / MySQL 8
    ✓ All 13 DB-layer tests pass (BOM, auto-consume, rollback, update, delete)
    ✓ All 15 HTTP integration scenarios pass via Flask test client:
        - role gate blocks non-admin/planning with 403
        - PM CRUD with validation
        - FG CRUD with inline BOM payload
        - inward → consumption → wastage → closing math
        - dispatch shortage returns 409 + shortage list, no orphan rows
        - update dispatch re-validates correctly
        - delete dispatch reverses consumption via FK cascade
        - brand filter works
        - Excel template / import / export round-trip
        - page renders with all tabs and BOM editor markup
"""
