# CRM · Lead Module — HCPERP.zip Integration Guide (Hinglish)

HCPERP_1.zip ka **Lead module** poori tarah HCPERP.zip ke apne conventions me
port kar diya gaya hai — **raw pymysql + session auth + common header/sidebar
design (hcptheme.css)**. Design 100% HCPERP.zip ka hai.

Is baar **app.py, core/menus.py aur templates/index.html ke COMPLETE modified
files** diye hain — bas purane ko replace kar do, koi Ctrl+H nahi chahiye.
Saath me CRM ka card **main dashboard pe sabse pehle (first)** add kar diya hai.

---

## 1) Files — kahan rakhni hain (structure preserve karo)

```
HCPERP/
├── app.py                              <- REPLACE (CRM blueprint register + perm key)
├── core/
│   └── menus.py                        <- REPLACE (CRM sidebar menu entry)
├── templates/
│   ├── index.html                      <- REPLACE (main page pe CRM card - FIRST)
│   └── crm/
│       └── leads/
│           ├── leads.html              <- NEW (list)
│           ├── lead_form.html          <- NEW (add/edit)
│           └── lead_view.html          <- NEW (detail)
├── modules/
│   └── crm/
│       ├── __init__.py                 <- NEW (blueprint export)
│       └── crm_leads_routes.py         <- NEW (saari routes)
├── migrations/
│   └── crm_leads_mysql.sql             <- NEW (DB tables + seed)
└── static/
    └── uploads/
        └── leads/                      <- NEW (file upload target - khaali folder)
```

> **REPLACE (3 files):** `app.py`, `core/menus.py`, `templates/index.html`
> **NEW (baaki sab):** crm module + templates + migration + upload folder

> WARNING: Ye 3 REPLACE files **isi HCPERP.zip** se nikaal ke modify kiye hain.
> Agar aapne in 3 me se kisi me beech me koi aur change kiya tha (zip dene ke
> baad), to wo change in naye files me nahi hoga — us soorat me sirf un 3 jagah
> manually add kar lena (neeche section 2 me exact changes diye hain). Warna
> seedha replace kaafi hai.

---

## 2) In 3 files me exactly kya change hua (reference / manual ke liye)

### app.py
- QC blueprint register line ke niche CRM register add hua:
  ```python
  from crm import crm_bp, ensure_lead_tables   # CRM Leads
  app.register_blueprint(crm_bp)               # /crm/leads
  ensure_lead_tables()                         # tables first-run bootstrap
  ```
- INDEX_PERM_KEYS list me sabse upar (Operations) ye add hua — taaki Access
  Control modal se non-admin users ko bhi CRM grant kar sako:
  ```python
  ('crm',                     'CRM · Leads'),
  ```

### core/menus.py
- MENUS = {...} dict ke end me "crm" entry add hui (Leads / New Lead / Trash).
  Sidebar data-driven hai isliye bas yahi ek jagah.

### templates/index.html
- "Operations" grid ke andar **sabse pehla card** CRM ka add hua:
  ```html
  {% if role in ['admin','Purchase','CRM','crm','Sales','sales']
        or 'crm' in allowed_sections %}
  <a class="nb-card rose" href="/crm/leads"> ... CRM · Leads ... </a>
  {% endif %}
  ```
  - admin ko hamesha dikhega; CRM/Sales role ko bhi; ya jis user ko Access
    Control se `crm` grant ho.

---

## 3) Database — tables + data

DB name default **erpnew** hai (HCP_DB_NAME env var). Do options:

- **Option A (recommended):** kuch mat karo — ensure_lead_tables() (app.py me
  add) app start hote hi saari lead_* tables + seed (statuses/sources/
  categories/ranges/contribution_config) auto-create kar deta hai. Idempotent —
  dobara run pe kuch nahi todta.

- **Option B (manual migration):** production me ek baar —
  ```bash
  mysql -u root -p erpnew < migrations/crm_leads_mysql.sql
  ```
  Safe to re-run (CREATE IF NOT EXISTS + INSERT IGNORE).

**Tables (12):** leads, lead_discussions, lead_attachments, lead_reminders,
lead_notes, lead_activity_logs, lead_contributions, contribution_config,
lead_statuses, lead_sources, lead_categories, product_ranges. Columns source
(models/lead.py) se 1:1 — har field cover. FK constraints jaan-bujh ke nahi
(soft-FK; assigned_to/created_by/modified_by/user_id -> User_Tbl(id)). Main
project ka raw-pymysql pattern same.

---

## 4) Features (har point cover)

- **Leads list** (/crm/leads) — KPI status chips, search, filters
  (status/source/priority/assigned), role-based visibility (admin/manager
  sabko; baaki sirf apni assigned/created/team wali).
- **Add/Edit** — Contact, Address, Requirement, Classification+Assignment
  (team multi-select), Notes.
- **Detail view** — overview, requirement+address, **Discussion** (comment +
  file attachments), **Reminders**, **private Notes**, **Activity timeline**,
  **Contributions** (points), **status workflow** (open/in_process/close/cancel
  + lost_reason).
- **Trash/Restore/Permanent delete**, **inline-edit**, **Excel export**.
- Lead code auto LD-0001..., contribution close-speed slab logic — source jaisa.

> Scope: sirf Lead entity + uske direct sub-entities. Clients/customers/
> quotations/sample-orders/leaderboard alag CRM modules hain (bahut doosri
> tables pe depend) — is scope me nahi the.

---

## 5) Access karo

App restart -> login -> main page pe **CRM · Leads** card (sabse pehla) ya
sidebar me **CRM -> All Leads**, ya direct:

```
/crm/leads
```

---

## 6) Quick checklist

- [ ] app.py REPLACE
- [ ] core/menus.py REPLACE
- [ ] templates/index.html REPLACE
- [ ] templates/crm/leads/ (3 html) copy
- [ ] modules/crm/ (2 files) copy
- [ ] migrations/crm_leads_mysql.sql copy
- [ ] static/uploads/leads/ folder maujood
- [ ] App restart -> main page pe CRM card + /crm/leads khule

Bas — Lead module ab HCPERP.zip ka native module, main-page card ke saath.
