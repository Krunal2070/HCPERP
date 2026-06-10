# Material Request Form (MRF) — Install Guide

Four files, two small integration edits. No existing code modified.

---

## 1. Backend — drop-in blueprint

**File:** `material_request_routes.py` → put it in your project root next to `production_dept_routes.py`.

**Edit `app.py`** — add two lines near the other blueprint registrations:

```python
from material_request_routes import material_request_bp
app.register_blueprint(material_request_bp)
```

On first run it auto-creates two tables (`material_requests`, `material_request_items`) and seeds two voucher-numbering styles:

| voucher_type | default prefix | suffix | digits |
|---|---|---|---|
| `mrf_pd` | `MRF/PD`  | `25-26` | 4 |
| `mrf_rd` | `MRF/RD`  | `25-26` | 4 |

You can change these anytime from **Procurement → Voucher Numbering** (same screen that manages PO numbers).

---

## 2. Admin / RM-Store / View page

**File:** `material_requests.html` → put it in your `templates/` folder (same folder as `production_department.html`).

Once registered, browse to **`/material_requests`**. What each role sees:

| Role | What they can do on this page |
|---|---|
| `admin` | See everything · approve/reject per item · bulk approve/reject · mark supplied · print voucher · print R&D stickers · delete |
| `Production` | See own PD requests · mark received |
| `RD` | See own RD requests · mark received · print stickers |
| `RM_Store` / `Stores` / `stores` | See approved/partial/supplied across both departments · mark supplied |

Header status auto rolls up from item statuses:
`Pending → Approved → Partial → Supplied` (or `Rejected` if all items rejected).

---

## 3. Production Department — add the button

**File:** `pd_mrf_snippet.html` — open it, copy its full contents, paste **once** just before `</body>` in `production_department.html`.

That gives you a floating "Material Request" pill at bottom-left of the page. A batch-selector dropdown inside the modal lists all current In-Process batches (from `production_dept_log` where `status='In Process'`). **Batch selection is mandatory** for PD requests.

**Optional — inline button in the In-Process grid:**
In `SP_CONFIG.inprocess.actions` (around line 737 of `production_department.html`), add one more button inside the template string:

```html
<button class="btn btn-sm" onclick="openMrfPdModal()"
  style="background:rgba(59,130,246,.12);color:#3b82f6;border:1px solid rgba(59,130,246,.3)">
  <i class="fa fa-clipboard-list"></i> Material Request
</button>
```

---

## 4. R&D — add the button

**File:** `rd_mrf_snippet.html` — same deal, paste once before `</body>` in `rd_sampling.html`.

Floating "Material Request" pill appears bottom-left. R&D requests do **not** require a batch — they're free-form with an optional "Reference / Product" field. Stickers print only from the R&D voucher detail view (`/material_requests`).

---

## 5. Permissions on the side menu (optional)

To make the `/material_requests` link show up for the right users in your side/nav menu, add it to their allowed pages in `production_dept_routes.py` → `_ROLE_DEFAULT_PAGES`. All API endpoints and the page itself already self-check roles, so this is cosmetic.

---

## API surface (for reference)

| Method | Endpoint | Who |
|---|---|---|
| GET | `/api/mrf/materials?q=&limit=` | any logged-in |
| GET | `/api/mrf/next_voucher_no?dept=PD|RD` | PD / RD role |
| GET | `/api/mrf/inprocess_batches` | PD role |
| POST | `/api/mrf/create` | PD / RD role |
| GET | `/api/mrf/list?dept=&status=&from=&to=&q=&scope=all|mine` | any requester / approver / supplier |
| GET | `/api/mrf/detail?id=` | any requester / approver / supplier |
| POST | `/api/mrf/item_action` `{item_id, action:'approve'/'reject', qty_approved?, reason?}` | admin |
| POST | `/api/mrf/bulk_action` `{mrf_id, action:'approve_all'/'reject_all', reason?}` | admin |
| POST | `/api/mrf/supply_item` `{item_id, qty_supplied?}` | admin / RM Store |
| POST | `/api/mrf/receive_item` `{item_id}` | requesting dept / admin |
| POST | `/api/mrf/delete` `{id}` | admin, or requester while Pending/Rejected |

---

## Print specs

- **Voucher print** — A4 landscape, matches image-2 layout (Sr/Product/Qty Demand/Qty Obtained/Remarks/Supplied Date/Received Date + signature strip).
- **Stickers** — 70 × 30 mm, one per approved item, auto-opens `window.print()`. The template matches image-3 (material name, `Sup.:`, `Sample Qty`).
