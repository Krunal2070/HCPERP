"""HCP Wellness R&D Sampling — autonomous agent.

Run: python rd_agent.py
Scheduled via Windows Task Scheduler every 2 hours.
"""
import os, json, sqlite3, datetime, sys, traceback
from dotenv import load_dotenv
load_dotenv()

import anthropic
import portal_helpers
import gmail_helpers

MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-20250514")
DB    = os.environ["DB_PATH"]
SENDER= os.environ["GMAIL_SENDER"]
CC    = os.environ["CC_ALWAYS"]
DRY   = os.environ.get("DRY_RUN","1") == "1"
MAX_RUN = int(os.environ.get("MAX_SENDS_PER_RUN","15"))
MAX_DAY = int(os.environ.get("MAX_SENDS_PER_DAY","40"))
COOL    = int(os.environ.get("COOLDOWN_DAYS","7"))
DRAFT_NEW = os.environ.get("DRAFT_ONLY_NEW_SUPPLIERS","1") == "1"

# ---------- DB helpers ----------
def db():
    c = sqlite3.connect(DB); c.row_factory = sqlite3.Row; return c

def was_contacted_recently(trade_name, supplier_email):
    with db() as c:
        r = c.execute("""SELECT 1 FROM contacts
                         WHERE lower(trade_name)=lower(?)
                           AND lower(supplier_email)=lower(?)
                           AND created_at > datetime('now', ?)
                         LIMIT 1""",
                      (trade_name, supplier_email, f"-{COOL} days")).fetchone()
        return r is not None

def sends_today():
    with db() as c:
        r = c.execute("""SELECT count(*) FROM contacts
                         WHERE action='sent'
                           AND created_at > datetime('now','-1 day')""").fetchone()
        return r[0]

def supplier_has_history(email_addr):
    """Consider a supplier 'known' if we ever contacted them before OR they appear in Gmail."""
    with db() as c:
        r = c.execute("SELECT 1 FROM contacts WHERE lower(supplier_email)=lower(?) LIMIT 1",
                      (email_addr,)).fetchone()
    if r: return True
    # Gmail fallback: any email in or out with this address
    hits = gmail_helpers.search_messages(f"from:{email_addr} OR to:{email_addr}", max_results=1)
    return len(hits) > 0

def log(sample_id, trade_name, supplier, email_addr, action, gmail_msg_id=None):
    with db() as c:
        c.execute("""INSERT INTO contacts (sample_id, trade_name, supplier, supplier_email, action, gmail_msg_id)
                     VALUES (?,?,?,?,?,?)""",
                  (sample_id, trade_name, supplier, email_addr, action, gmail_msg_id))
        c.commit()

# ---------- Tool implementations ----------
_run_sends = 0

def tool_get_pending_samples(_):
    return portal_helpers.get_pending()

def tool_search_gmail(args):
    q = args["query"]
    return gmail_helpers.search_messages(q, max_results=args.get("max_results",15))

def tool_read_thread(args):
    return gmail_helpers.read_thread(args["thread_id"])

def tool_find_known_supplier(args):
    """Look up previously-contacted suppliers for a material from our own DB."""
    name = args["trade_name"]
    with db() as c:
        rows = c.execute("""SELECT DISTINCT supplier, supplier_email, max(created_at) last_seen
                            FROM contacts
                            WHERE lower(trade_name) LIKE lower(?)
                            GROUP BY supplier_email
                            ORDER BY last_seen DESC LIMIT 10""",
                         (f"%{name}%",)).fetchall()
    return [dict(r) for r in rows]

def tool_draft_and_send_email(args):
    global _run_sends
    sample_id  = args["sample_id"]
    trade_name = args["trade_name"]
    supplier   = args["supplier_name"]
    to         = args["to_email"].strip()
    subject    = args["subject"]
    body       = args["body"]

    # ---- Safety rails (hard, not LLM-overrideable) ----
    if DRY:
        print(f"[DRY_RUN] Would send to {to} re '{subject}'")
        log(sample_id, trade_name, supplier, to, "dry_run")
        return {"status":"dry_run", "to": to}
    if was_contacted_recently(trade_name, to):
        return {"status":"skipped_cooldown",
                "reason": f"{to} contacted for {trade_name} within {COOL} days"}
    if _run_sends >= MAX_RUN:
        return {"status":"skipped_run_cap", "reason": f"MAX_SENDS_PER_RUN={MAX_RUN} reached"}
    if sends_today() >= MAX_DAY:
        return {"status":"skipped_day_cap", "reason": f"MAX_SENDS_PER_DAY={MAX_DAY} reached"}

    known = supplier_has_history(to)
    force_draft = DRAFT_NEW and not known

    try:
        if force_draft:
            r = gmail_helpers.create_draft(to, CC, subject, body, SENDER)
            log(sample_id, trade_name, supplier, to, "drafted", r.get("id"))
            return {"status":"drafted_new_supplier","draft_id": r.get("id"), "to": to}
        else:
            r = gmail_helpers.send(to, CC, subject, body, SENDER)
            _run_sends += 1
            log(sample_id, trade_name, supplier, to, "sent", r.get("id"))
            return {"status":"sent","message_id": r.get("id"), "to": to}
    except Exception as e:
        return {"status":"error", "error": str(e)}

def tool_log_action(args):
    log(args["sample_id"], args["trade_name"], args["supplier_name"],
        args.get("supplier_email",""), args["action"])
    return {"status":"logged"}

TOOL_IMPL = {
    "get_pending_samples":  tool_get_pending_samples,
    "search_gmail":         tool_search_gmail,
    "read_thread":          tool_read_thread,
    "find_known_supplier":  tool_find_known_supplier,
    "draft_and_send_email": tool_draft_and_send_email,
    "log_action":           tool_log_action,
}

# ---------- Tool schemas for Claude ----------
TOOLS = [
    {"name":"get_pending_samples","description":"Fetch current pending R&D sample requests from the portal.",
     "input_schema":{"type":"object","properties":{},"required":[]}},
    {"name":"search_gmail","description":"Search Gmail with a Gmail query string. Returns recent matching messages (subject, from, date, snippet, threadId).",
     "input_schema":{"type":"object","properties":{
        "query":{"type":"string","description":"Gmail search query, e.g. '\"Colloidal Sulphur\" sample newer_than:14d'"},
        "max_results":{"type":"integer","default":15}},"required":["query"]}},
    {"name":"read_thread","description":"Fetch all messages in a Gmail thread by threadId.",
     "input_schema":{"type":"object","properties":{"thread_id":{"type":"string"}},"required":["thread_id"]}},
    {"name":"find_known_supplier","description":"Return previously-contacted suppliers for a material from our agent memory.",
     "input_schema":{"type":"object","properties":{"trade_name":{"type":"string"}},"required":["trade_name"]}},
    {"name":"draft_and_send_email","description":"Send (or draft, for new suppliers) a sample-request email. Auto-CC purchase2@ and sonal@.",
     "input_schema":{"type":"object","properties":{
        "sample_id":{"type":"integer"}, "trade_name":{"type":"string"},
        "supplier_name":{"type":"string"}, "to_email":{"type":"string"},
        "subject":{"type":"string"}, "body":{"type":"string"}
      },"required":["sample_id","trade_name","supplier_name","to_email","subject","body"]}},
    {"name":"log_action","description":"Record an observation (e.g. a denial or paid-only reply detected) without sending an email.",
     "input_schema":{"type":"object","properties":{
        "sample_id":{"type":"integer"}, "trade_name":{"type":"string"},
        "supplier_name":{"type":"string"}, "supplier_email":{"type":"string"},
        "action":{"type":"string","enum":["denied","paid_only","accepted","received","note"]}
      },"required":["sample_id","trade_name","supplier_name","action"]}},
]

# ---------- System prompt ----------
SYSTEM_PROMPT = f"""You are the HCP Wellness R&D Sampling agent.

GOAL
Every PENDING sample in the portal must have at least 3 distinct supplier sample-requests sent within the last 14 days.

WORKFLOW (each run)
1. Call get_pending_samples to see the current pending list.
2. For each pending sample, call search_gmail with the trade name plus 'sample newer_than:14d' to see who has already been contacted and what replies came back.
3. Classify each sample's coverage:
   - covered: already =3 suppliers contacted
   - gap: fewer than 3 suppliers contacted, or some have denied/paid-only
4. For gaps, call find_known_supplier for existing suppliers; prefer them over brand-new ones.
5. Draft and send sample-request emails (draft_and_send_email) to fill the gap up to 3 suppliers.
   - Always CC purchase2@hcpwellness.in and sonal@hcpwellness.in (the tool adds these automatically).
   - The subject MUST follow the pattern:  Sample Request – {{TRADE NAME}} | HCP Wellness Pvt. Ltd
   - The body MUST follow the HCP template below.
6. If a reply you read says the supplier declines, only offers paid samples, or will not supply the item, call log_action with action='denied' or 'paid_only' and find a replacement.
7. Do NOT re-contact a supplier for the same material within 7 days (the tool enforces this).

LIMITS (enforced by tools — do not try to bypass)
- Max {MAX_RUN} sends per run, {MAX_DAY} per day.
- New suppliers (no prior Gmail or DB history) will be saved to Drafts automatically, not sent. Mention this in the final summary.

EMAIL TEMPLATE (use exactly, filling in braces):
---
Dear Sir/Madam,

Greetings from HCP Wellness Pvt. Ltd!

We are a leading cosmetic and personal care product manufacturer based in Ahmedabad, Gujarat. We have an urgent requirement for the following raw material and would like to request a sample from you for evaluation:

Trade Name : {{TRADE_NAME}}
INCI Name  : {{INCI_NAME}}
Application: {{APPLICATION}}
Sample Quantity: {{QTY}}
Required By: {{REQUIRED_BY}}

Kindly share the following along with the sample at the earliest:
- COA and MSDS
- Rate per kg
- MOQ
- Lead time
- Pack size options

Looking forward to your prompt response.

Thanks & Regards,
Tarak Bhavsar
(SENIOR PURCHASE MANAGER)
HCP Wellness Pvt. Ltd
Cell : +91 93 2891 1749
Email: tarak@hcpwellness.in
---

When you are done processing all pending samples, output a final plain-text run summary listing: samples touched, emails sent, emails drafted, denials/paid-offers flagged, and any samples still not yet at 3 suppliers."""

# ---------- Main loop ----------
def run_agent():
    client = anthropic.Anthropic()
    messages = [{"role":"user","content":"Run the R&D Sampling cycle now."}]
    run_id = None
    with db() as c:
        cur = c.execute("INSERT INTO runs (summary) VALUES ('in_progress')")
        run_id = cur.lastrowid; c.commit()

    total_in = total_out = 0
    while True:
        resp = client.messages.create(
            model=MODEL, system=SYSTEM_PROMPT, tools=TOOLS,
            messages=messages, max_tokens=4096)
        total_in  += resp.usage.input_tokens
        total_out += resp.usage.output_tokens

        # Append assistant reply
        messages.append({"role":"assistant","content":resp.content})

        if resp.stop_reason == "end_turn":
            break

        # Collect tool_use blocks and execute
        tool_results = []
        for block in resp.content:
            if block.type != "tool_use": continue
            name = block.name; args = block.input
            try:
                result = TOOL_IMPL[name](args)
            except Exception as e:
                result = {"error": f"{e}", "traceback": traceback.format_exc()[:1000]}
            tool_results.append({
                "type":"tool_result","tool_use_id": block.id,
                "content": json.dumps(result)[:15000]  # guardrail
            })
        if not tool_results:
            break
        messages.append({"role":"user","content":tool_results})

    # Extract final text summary
    final_text = ""
    for b in resp.content:
        if getattr(b,"type",None) == "text":
            final_text += b.text

    with db() as c:
        c.execute("UPDATE runs SET summary=?, sends=?, tokens_in=?, tokens_out=? WHERE id=?",
                  (final_text[:8000], _run_sends, total_in, total_out, run_id))
        c.commit()

    # Email the summary to you
    recipient = os.environ.get("SUMMARY_RECIPIENT")
    if recipient and not DRY:
        subject = f"[R&D Agent] Run summary {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}"
        gmail_helpers.send(recipient, "", subject, final_text or "(no summary)", SENDER)

    print(final_text)
    return final_text

if __name__ == "__main__":
    try:
        run_agent()
    except Exception as e:
        print(f"FATAL: {e}", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)