# Common Header — Integration Guide

`templates/partials/_header.html` ek single reusable header hai jo har page pe same dikhega
aur saare tools ek hi jagah laata hai. Aapke `partials/_sidebar.html` jaisa hi include pattern.

## Ek page pe kaise lagayein (2 step)

`<body>` ke top par (page content se pehle) ye add karo:

```jinja
{% set page_title = "Raw Material" %}
{% set breadcrumb = [
    {"label": "Home",        "url": "/"},
    {"label": "Procurement", "url": "/procurement"},
    {"label": "Purchase",    "url": "#"},
    {"label": "Raw Material", "url": "#"}
] %}
{% include 'partials/_header.html' %}
```

Bas. Title + breadcrumb upar set karo, phir include. Har page pe sirf yehi 2 cheez badlegi.

Phir us page ka **purana header block hata do** — yaani:
- `<header class="topbar"> ... </header>`  (36 pages)  ya
- `<header class="top-navbar"> ... </header>`  (material_rates, rd_sampling)

Purani header ki CSS file mein padi rahe to koi dikkat nahi (bas unused ho jayegi),
lekin purana `<header>` markup zaroor hatao warna do header dikhenge.

## Variables (sab optional)

| Variable     | Type             | Default                          |
|--------------|------------------|----------------------------------|
| `page_title` | string           | aakhri breadcrumb label / "Dashboard" |
| `breadcrumb` | list of {label,url} | `[{Home, /}]`                 |
| `page_subtitle` | string        | breadcrumb ki jagah dikhega      |
| `portal_url` | string           | `/`                              |
| `brand`      | {name,sub,mark,logo,url} | left logo + brand block  |
| `live`       | bool             | green "LIVE" pill                |
| `badges`     | list of {label,color} | status pills (violet/green/blue/amber/red) |
| `quick_links`| list of {label,url} | pill buttons (HCP Stock / PM Stock) |
| `tasks_url`  | string           | yellow "Tasks" button            |
| `notif_count`| int              | bell pe number (0 = hidden)      |

Notification count page JS se bhi update kar sakte ho: `hcpHdr.setNotif(2, "Batch ready")`.

### Example — purane headers replicate karna

RM Store / Planning Dashboard jaisa full header:
```jinja
{% set page_title = "RM Store Dashboard" %}
{% set page_subtitle = "Stock - GRN - Godown - Factory" %}
{% set brand = {"name": "HCP Wellness", "sub": "PM Stock V3", "mark": "H"} %}
{% set live = True %}
{% set badges = [{"label": "BATCH DISPENSING", "color": "violet"}] %}
{% set quick_links = [{"label": "HCP Stock", "url": "/hcp_stock"},
                      {"label": "PM Stock",  "url": "/pm_stock"}] %}
{% set tasks_url = "/task_reminders" %}
{% set notif_count = 2 %}
{% include 'partials/_header.html' %}
```

Logo image use karna ho to: `{"name": "HCP Wellness", "sub": "LAN Portal", "logo": "/static/images/LOGO.jpg"}`

User ka naam/role automatic `session` se aata hai (`User_Name`/`UID`, `User_Type`/`role`).

## Tools jo is ek header mein aa gaye

- **Hamburger (≡)** — `window.toggleSidebar()` call karta hai agar page mein hai (warna `hcp:toggleSidebar` event fire karta hai)
- **Title + breadcrumb** — clickable links
- **Live date-time pill** — "Wed, 10 Jun, 2026 10:43:58 am" format
- **Search** — Ctrl+K. Page ka `openHeaderSearch()` ya `#searchInput` use karta hai, warna `hcp:search` event
- **Notifications (bell)** — popover; `#hcpNotifBody` set karke content daal sakte ho
- **User dropdown** — andar: **Back to Portal**, Update Profile, Switch Theme, Settings,
  (admin pe) Reset App Data, Logout. Ye sab page ke existing global functions call karte hain
  (`openUpdateProfile`, `cycleTheme`, `openSettings`, `openAdminReset`) — agar function nahi hai to
  chup-chaap skip, koi error nahi.

Pura self-contained hai: apni CSS (`.hcp-*` prefix, kisi page se clash nahi) + apna JS (`window.hcpHdr`).
ASCII-safe — saare icons inline SVG, koi emoji nahi. Dark theme support (`data-theme`).

---

## Full Header Audit (saare 60 templates)

`STYLE` = abhi kaunsa header use ho raha hai. `ACTION` = kya karna hai.

| Template | Current style | Action |
|---|---|---|
| index.html | topbar | replace -> _header |
| procurement.html | topbar | replace -> _header |
| procurement/procurement.html | topbar | replace -> _header |
| procurement/production_initiater.html | topbar | replace -> _header |
| production_initiater.html | topbar | replace -> _header |
| rm_store/production_initiater.html | topbar | replace -> _header |
| production_department.html | topbar | replace -> _header |
| cash_management.html | topbar | replace -> _header |
| fg.html | topbar | replace -> _header |
| general_op.html | topbar | replace -> _header |
| machine_entry.html | topbar | replace -> _header |
| inventory/inventory_mgmt.html | topbar | replace -> _header |
| inventory_mgmt.html | topbar | replace -> _header |
| inventory/grn_box_repair.html | topbar | replace -> _header |
| inventory/trs_register.html | topbar | replace -> _header |
| grn_box_repair.html | topbar | replace -> _header |
| hcp_stock.html | topbar | replace -> _header |
| hr_salary.html | topbar | replace -> _header |
| cctv_admin.html | topbar | replace -> _header |
| cctv_groups.html | topbar | replace -> _header |
| cctv_live_wall.html | topbar | replace -> _header |
| cctv_playback.html | topbar | replace -> _header |
| cms.html | topbar | replace -> _header |
| access_control.html | topbar | replace -> _header |
| backup_dashboard.html | topbar | replace -> _header |
| planning_dashboard.html | topbar | replace -> _header |
| material_requests.html | topbar | replace -> _header |
| packing.html | topbar | replace -> _header |
| packing--.html | topbar | replace -> _header |
| pm_stock/pm_stock.html | topbar | replace -> _header |
| qc/qc_dashboard.html | topbar | replace -> _header |
| qc/qc_sampling.html | topbar | replace -> _header |
| task_reminders.html | topbar | replace -> _header |
| task_scheduler.html | topbar | replace -> _header |
| material_rates.html | top-navbar | replace -> _header |
| rd_sampling.html | top-navbar | replace -> _header |
| canteen.html | custom | replace -> _header (full page) |
| lunch_coupons.html | custom | replace -> _header (full page) |
| manage_users.html | custom | replace -> _header (full page) |
| create_user.html | custom | replace -> _header (full page) |
| rd_agent_dashboard.html | custom | replace -> _header (full page) |
| floor_pm_stock.html | custom | replace -> _header (full page) |
| trs_view.html | custom | replace -> _header (full page) |
| pm_stock/pm_stock_audit.html | custom | replace -> _header (full page) |
| login.html | custom | SKIP (auth page) |
| force_reset_password.html | custom | SKIP (auth page) |
| device_pending.html | custom | SKIP (auth page) |
| device_recover.html | custom | SKIP (auth page) |
| qc/qc_coa_print.html | custom | SKIP (print page) |
| *_snippet.html (pd_mrf, rd_mrf, kpi_card) | custom | SKIP (partial snippet) |
| inventory/_transfers.html, pm_stock/_transfers.html | custom | SKIP (partial) |
| pm_stock_qr_modal.html | custom | SKIP (modal) |
| sidebar_nav_addition.html | custom | SKIP (snippet) |
| partials/_sidebar.html | custom | SKIP (sidebar partial) |
| inventory_mgmt old.html, packingold.html | topbar | SKIP (old backups) |

**Skip karo:** login/auth pages, print pages, snippets/modals/partials, aur "old" backup files —
inhe full header nahi chahiye.
