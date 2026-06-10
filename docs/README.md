# Inventory Management Module — Installation & Integration

> **Named `inventory_mgmt`** to avoid any conflict with a leftover `inventory.py` you may have.
> If you have an old `inventory.py` placeholder file, you can safely delete it — it was never registered in app.py.

Three files, a one-line registration in `app.py`, no changes to any other existing module.

## 📁 File placement

```
your-flask-root/
├── app.py
├── procurement.py             ← existing, untouched
├── fg_routes.py               ← existing, untouched
├── inventory_mgmt.py          ← NEW — drop this file here
├── templates/
│   ├── procurement.html       ← existing, untouched
│   ├── pm_stock.html          ← existing, untouched
│   ├── fg.html                ← existing, untouched
│   └── inventory_mgmt.html    ← NEW — drop this file here
└── static/
    ├── css/hcptheme.css       ← existing, re-used
    ├── js/
    │   ├── suppliers.js       ← existing, untouched
    │   ├── fg.js              ← existing, untouched
    │   └── pm_stock_main.js   ← existing, untouched
    └── inventory/
        └── inventory_mgmt.js  ← NEW — drop this file here
```

## 🔌 Register in `app.py`

Add two lines — one import, one registration call. Put them next to where you already register `procurement`, `fg`, and your existing `inventory`:

```python
import inventory_mgmt                       # ← NEW
# ... your existing imports ...

# ... existing calls to procurement.register_procurement(app), fg_routes.register_fg(app), etc ...

inventory_mgmt.register_inventory_mgmt(app)  # ← NEW
```

That's the entire integration. The module creates its own helper tables on first run (`inventory_brand_dept`, `inventory_supplier_dept`, `inventory_last_purchase`) and adds a few safe optional columns to `pm_products` and `FG_Names` via `ALTER TABLE … ADD COLUMN` (all wrapped in try/except, so re-running is harmless).

## 🌐 URLs exposed

| URL | Purpose |
|---|---|
| `/inventory_mgmt` | The page itself |
| `/api/inventory_mgmt/items?department=RM\|PM\|FG` | List items for a dept |
| `/api/inventory_mgmt/items/save` (POST) | Create or update an item |
| `/api/inventory_mgmt/items/delete` (POST) | Delete one or many |
| `/api/inventory_mgmt/brands?department=…` | List brands scoped by dept |
| `/api/inventory_mgmt/brands/save`, `/delete` | Brand CRUD |
| `/api/inventory_mgmt/suppliers?department=…` | List suppliers scoped by dept |
| `/api/inventory_mgmt/suppliers/save`, `/delete` | Supplier CRUD |
| `/api/inventory_mgmt/lookups` | PM types, material groups, UOMs, GST rates |
| `/api/inventory_mgmt/last_purchase/refresh` (POST) | Rebuild last-supplier/rate cache from GRN |
| `/api/inventory_mgmt/share/contacts?suppliers=a\|b` | Contact lookup for WhatsApp/Email |
| `/api/inventory_mgmt/can_access` | Permission probe |

## 🔐 Permissions

- **View**: any logged-in user
- **Edit / Create / Delete**: admin role OR `sonal` / `tarak` UIDs (adjust `_can_edit_inventory()` in `inventory_mgmt.py`)

## ✅ Requirement checklist

| # | Requirement | Where |
|---|---|---|
| 1 | Item creation with department choice | `itemModal` + `/api/inventory_mgmt/items/save` |
| 2 | All features from Procurement / PM_Stock / FG visible | Dept-switched grid pulls from `procurement_materials`, `pm_products`, `FG_Names` directly |
| 3 | Brand creation & assignment per dept | Brands panel + `procurement_brands` + `inventory_brand_dept` |
| 4 | Last supplier, last purchase rate, GST% | Columns in grid + form fields + refresh button that pulls from GRN |
| 5 | Escape closes every modal | `_installModalHandlers()` in `inventory_mgmt.js` |
| 6 | Click outside does NOT close | Same handler — intentional no-op |
| 7 | Multi-select + WhatsApp + Email on every grid | Bulk bar on each of items/brands/suppliers |
| 8 | Dept filter shows only that dept's items/brands/suppliers | `invSwitchDept()` reloads all three via dept-scoped API calls |
| 9 | Supplier creation separate per dept | Supplier modal asks for applicable departments; `?department=` filters the list |

## 🧩 Data model

Nothing is duplicated. The page is a **view over your existing tables**:

- **RM items** → `procurement_materials` (same as Procurement module uses)
- **PM items** → `pm_products` (same as PM_Stock module uses)
- **FG items** → `FG_Names` (same as FG module uses)
- **Brands** → `procurement_brands` + new `inventory_brand_dept` mapping
- **Suppliers** → `procurement_suppliers` + new `inventory_supplier_dept` mapping
- **Stock qty**:
  - RM — live from `StkSum.xlsx` (same path as Procurement)
  - PM — aggregated from `pm_stock` table (if it exists)
  - FG — aggregated from `FG_stock` table (if it exists; otherwise 0)

Edits you make here are visible in the old pages and vice-versa — single source of truth.

## ⚠️ Caveats

1. **Supplier / Brand dept mapping for existing data**: Existing suppliers and brands won't be pre-assigned to any department. Open each one in the Suppliers / Brands panel and tick the departments it applies to (takes one click). Or run a quick SQL seed if you have a convention:
   ```sql
   -- Example: mark every current supplier as RM
   INSERT IGNORE INTO inventory_supplier_dept (supplier_id, department)
   SELECT id, 'RM' FROM procurement_suppliers;
   ```

2. **PM stock table name**: Code assumes `pm_stock(product_id, qty)`. If your actual table has different column names, tweak `_read_pm_stock()` in `inventory_mgmt.py` — it's 10 lines. Missing table is handled gracefully (zero stock shown).

3. **FG stock table name**: Code assumes `FG_stock(fg_id, qty)`. Same comment as above — tweak `_read_fg_stock()` if your FG stock lives elsewhere. If no FG stock table exists, FG page just shows 0 stock; everything else still works.

4. **Last purchase refresh** only pulls from `procurement_grn_items` + `procurement_grn` (RM). For PM / FG, the `last_supplier` / `last_rate` fields are populated when you manually edit an item or when you save a GRN (if you later wire it up).

## 🐛 Troubleshooting

- **Blank page / 404 at `/inventory_mgmt`** → Did you add `inventory_mgmt.register_inventory_mgmt(app)` in `app.py`?
- **"Template not found: inventory_mgmt.html"** → Make sure the file is in the `templates/` folder, not alongside the `.py`.
- **JS 404 at `static/inventory/inventory_mgmt.js`** → Create the `static/inventory/` folder and drop the JS in it.
- **"permission denied" on save** → You're logged in but not as admin. Either promote your user to admin or add your UID to the allowed set in `_can_edit_inventory()`.
- **No suppliers/brands show up for a department** → You need to tick the department checkbox when editing each supplier/brand once (or run the SQL seed above).
- **PM or FG stock shows 0 everywhere** → Table names differ. Edit `_read_pm_stock()` / `_read_fg_stock()` in `inventory_mgmt.py`.
