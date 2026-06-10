# Header Migration — Report

Common header (`partials/_header.html`) ab **36 pages** mein lag gaya hai. Zip ko apne
project root pe extract karo — `templates/...` structure same hai, direct overwrite ho jayega.

## Kya hua har migrated page mein
1. Purana header block (`<header class="topbar">…</header>` ya `<div class="topbar">…</div>`
   ya `<header class="top-navbar">…</header>`) **hata diya**.
2. Uski jagah ye add hua (har page ka apna title/breadcrumb/brand):
   ```jinja
   {% set page_title = "..." %}
   {% set breadcrumb = [...] %}     (ya page_subtitle)
   {% set brand = {...} %}
   {% set portal_url = "/" %}
   {% include 'partials/_header.html' %}
   ```

Div/header balance har file mein verify kiya gaya — kuch toota nahi.
3 pages (`procurement/procurement`, `fg`, `pm_stock`) ka JS purane header IDs use karta tha —
sab **null-safe** hai (`if(!el) return`), to header hatne se koi error nahi aata.

## Migrated (36)
index, procurement, procurement/procurement, procurement/production_initiater,
production_initiater, rm_store/production_initiater, production_department, cash_management,
fg, general_op, machine_entry, inventory/inventory_mgmt, inventory_mgmt,
inventory/grn_box_repair, inventory/trs_register, grn_box_repair, hcp_stock, hr_salary,
cctv_admin, cctv_groups, cctv_live_wall, cctv_playback, cms, access_control, backup_dashboard,
planning_dashboard, material_requests, packing, packing--, pm_stock/pm_stock, qc/qc_dashboard,
qc/qc_sampling, task_reminders, task_scheduler, material_rates, rd_sampling

## Abhi NAHI kiye (8) — manual review chahiye
Inka header bilkul custom hai (topbar/top-navbar class nahi), isliye auto-migrate nahi kiya
taaki kuch toote na:

| Page | Custom header | Suggestion |
|---|---|---|
| canteen.html | side nav + Back to Portal | sub-page; chaaho to include lagaa du |
| lunch_coupons.html | `.page-header` + back-btn | include + page-header hatao |
| manage_users.html | minimal (sirf title) | include add karo |
| create_user.html | form + "Back to users" link | form sub-page; rakho jaisa hai |
| rd_agent_dashboard.html | `.page-header` block | include + page-header hatao |
| floor_pm_stock.html | `.fps-brand` custom bar | include + fps-brand hatao |
| trs_view.html | embedded view (no header) | shayad header chahiye hi nahi |
| pm_stock/pm_stock_audit.html | "Back to PM Stock" link | sub-page; existing back theek hai |

Bolo to in 8 ko bhi ek-ek karke kar dunga (har ek ka intent confirm karke).

## SKIP (jaan-boojhkar)
login, force_reset_password, device_pending, device_recover (auth), qc/qc_coa_print (print),
saare *_snippet/_transfers/_modal (partials), aur `inventory_mgmt old.html` + `packingold.html`
(purane backup). Inhe full header nahi chahiye.

## Verify kaise karein
Project chalao, har module khol ke dekho — header same aana chahiye. Title/breadcrumb galat lage
to upar wali 4 `{% set %}` lines edit karo, header markup chhune ki zaroorat nahi.
