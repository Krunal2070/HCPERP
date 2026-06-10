"""
rd_agent_dashboard.py
═══════════════════════════════════════════════════════════════════════════════
  HCP Wellness — R&D Sampling Assistant Dashboard (manual, zero-cost)

  Drop this file next to app.py and rd_sampling_routes.py.
  Register it once in app.py:
      from rd_agent_dashboard import rd_agent_bp
      app.register_blueprint(rd_agent_bp)

  Page URL:   http://192.168.2.91/rd_agent
  Opens in a separate browser tab (no interference with existing portal UI).

  What it does
  ------------
  • Shows every PENDING sample from rd_sampling_requests
  • For each, tells you how many distinct suppliers were contacted in last 14 days
  • "Find Suppliers"       → pulls prior suppliers from Gmail history + your DB
  • "Google New Suppliers" → uses the free Custom Search API key you set up
  • "Open in Gmail"        → pre-fills compose (mailto with body)
  • "Send via Gmail API"   → one-click send using credentials.json / token.json
  • Fragrance/flavour detection blocks the Google button for those materials
  • All sent/drafted emails are logged to a local SQLite file (rd_agent_log.db)

  What it does NOT do
  -------------------
  • No background schedule, no autonomy, no LLM calls
  • No automatic reply classification — you read replies yourself in Gmail

  Requires
  --------
  pip install google-api-python-client google-auth-httplib2 google-auth-oauthlib requests
  (You already installed these for the earlier agent setup.)

  Config via environment variables (set in start_portal.bat):
      GMAIL_CREDENTIALS_FILE   = E:\\hcp_rd_agent\\credentials.json
      GMAIL_TOKEN_FILE         = E:\\hcp_rd_agent\\token.json
      GMAIL_SENDER             = tarak@hcpwellness.in
      GOOGLE_SEARCH_API_KEY    = <AIzaSy...>
      GOOGLE_SEARCH_CX         = <17-char CX>
      RD_AGENT_DB              = E:\\hcp_rd_agent\\rd_agent_log.db
      RD_AGENT_CC              = purchase2@hcpwellness.in,sonal@hcpwellness.in
═══════════════════════════════════════════════════════════════════════════════
"""
import os
import re
import base64
import sqlite3
import urllib.parse
from datetime import datetime
from functools import wraps

from flask import (
    Blueprint, render_template, request, jsonify, session, abort, current_app
)

import sampling_portal  # existing helper, gives MySQL connection

# ── Optional imports (dashboard works partially without these) ────────────
try:
    from google.auth.transport.requests import Request as _GRequest
    from google.oauth2.credentials import Credentials as _GCredentials
    from google_auth_oauthlib.flow import InstalledAppFlow as _GFlow
    from googleapiclient.discovery import build as _gbuild
    from email.mime.text import MIMEText
    _GMAIL_AVAILABLE = True
except ImportError:
    _GMAIL_AVAILABLE = False

try:
    import requests as _requests
    _REQUESTS_AVAILABLE = True
except ImportError:
    _REQUESTS_AVAILABLE = False


# ══════════════════════════════════════════════════════════════════════════
#  Blueprint
# ══════════════════════════════════════════════════════════════════════════
rd_agent_bp = Blueprint('rd_agent', __name__, url_prefix='/rd_agent')


# ── Config ───────────────────────────────────────────────────────────────
GMAIL_CREDS   = os.environ.get("GMAIL_CREDENTIALS_FILE", "")
GMAIL_TOKEN   = os.environ.get("GMAIL_TOKEN_FILE", "")
GMAIL_SENDER  = os.environ.get("GMAIL_SENDER", "tarak@hcpwellness.in")
GSEARCH_KEY   = os.environ.get("GOOGLE_SEARCH_API_KEY", "")
GSEARCH_CX    = os.environ.get("GOOGLE_SEARCH_CX", "")
LOG_DB        = os.environ.get("RD_AGENT_DB", "rd_agent_log.db")
CC_LIST       = os.environ.get("RD_AGENT_CC", "purchase2@hcpwellness.in,sonal@hcpwellness.in")

GMAIL_SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.compose",
]

FRAGRANCE_KEYWORDS = (
    "perfume", "fragrance", "flavour", "flavor",
    "essence", "aroma", "attar"
)


# ══════════════════════════════════════════════════════════════════════════
#  Auth guard
# ══════════════════════════════════════════════════════════════════════════
def _login_required(f):
    @wraps(f)
    def wrapped(*args, **kwargs):
        if not session.get('logged_in'):
            return jsonify({'status': 'error', 'message': 'Not logged in'}), 401
        return f(*args, **kwargs)
    return wrapped


# ══════════════════════════════════════════════════════════════════════════
#  Local SQLite log (survives portal restarts, tracks every email we touch)
# ══════════════════════════════════════════════════════════════════════════
def _init_log_db():
    con = sqlite3.connect(LOG_DB)
    con.executescript("""
        CREATE TABLE IF NOT EXISTS rd_agent_contacts (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            sample_id      INTEGER,
            trade_name     TEXT,
            supplier_name  TEXT,
            supplier_email TEXT,
            action         TEXT,   -- sent | drafted | opened_in_gmail | noted
            gmail_msg_id   TEXT,
            user_id        TEXT,
            created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS ix_trade ON rd_agent_contacts(trade_name);
        CREATE INDEX IF NOT EXISTS ix_email ON rd_agent_contacts(supplier_email);
        CREATE INDEX IF NOT EXISTS ix_date  ON rd_agent_contacts(created_at);
    """)
    con.commit()
    con.close()


def _log_contact(sample_id, trade_name, supplier_name, supplier_email,
                 action, gmail_msg_id=None):
    con = sqlite3.connect(LOG_DB)
    con.execute("""
        INSERT INTO rd_agent_contacts
          (sample_id, trade_name, supplier_name, supplier_email,
           action, gmail_msg_id, user_id)
        VALUES (?,?,?,?,?,?,?)
    """, (sample_id, trade_name, supplier_name, supplier_email,
          action, gmail_msg_id, session.get('UID') or session.get('User_Name') or ''))
    con.commit()
    con.close()


_init_log_db()


# ══════════════════════════════════════════════════════════════════════════
#  Gmail helpers
# ══════════════════════════════════════════════════════════════════════════
def _gmail_service():
    """Returns an authenticated Gmail API client, or None if not available."""
    if not _GMAIL_AVAILABLE or not GMAIL_CREDS or not GMAIL_TOKEN:
        return None
    creds = None
    if os.path.exists(GMAIL_TOKEN):
        creds = _GCredentials.from_authorized_user_file(GMAIL_TOKEN, GMAIL_SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(_GRequest())
        else:
            if not os.path.exists(GMAIL_CREDS):
                return None
            flow = _GFlow.from_client_secrets_file(GMAIL_CREDS, GMAIL_SCOPES)
            creds = flow.run_local_server(port=0)
        with open(GMAIL_TOKEN, "w") as f:
            f.write(creds.to_json())
    return _gbuild("gmail", "v1", credentials=creds, cache_discovery=False)


def _gmail_search(query, max_results=20):
    svc = _gmail_service()
    if not svc:
        return []
    try:
        res = svc.users().messages().list(
            userId="me", q=query, maxResults=max_results
        ).execute()
    except Exception as e:
        current_app.logger.exception("Gmail search failed")
        return []

    out = []
    for m in res.get("messages", []):
        try:
            full = svc.users().messages().get(
                userId="me", id=m["id"], format="metadata",
                metadataHeaders=["From", "To", "Cc", "Subject", "Date"]
            ).execute()
        except Exception:
            continue
        headers = {h["name"]: h["value"] for h in full["payload"]["headers"]}
        out.append({
            "id":       m["id"],
            "threadId": full["threadId"],
            "snippet":  full.get("snippet", ""),
            "from":     headers.get("From", ""),
            "to":       headers.get("To", ""),
            "subject":  headers.get("Subject", ""),
            "date":     headers.get("Date", ""),
        })
    return out


_EMAIL_RE = re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")


def _extract_email_from_header(raw):
    """Pull 'Name <email>' → email.  Or 'email' → email."""
    if not raw:
        return ""
    m = _EMAIL_RE.search(raw)
    return m.group(0).lower() if m else ""


def _gmail_send(to, subject, body, cc=None, from_addr=None):
    """Send email. `from_addr` defaults to GMAIL_SENDER env var but can be
    overridden (per-user sender alias) so the From header matches the signer.

    Note: Gmail API requires the authenticated account to have the 'from_addr'
    configured as a 'Send As' alias, otherwise the send fails.
    If the alias isn't configured, we fall back to the default GMAIL_SENDER.
    """
    svc = _gmail_service()
    if not svc:
        raise RuntimeError("Gmail API not configured")
    msg = MIMEText(body, "plain", "utf-8")
    msg["To"] = to
    if cc:
        msg["Cc"] = cc
    msg["From"] = from_addr or GMAIL_SENDER
    msg["Subject"] = subject
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    return svc.users().messages().send(userId="me", body={"raw": raw}).execute()


# ══════════════════════════════════════════════════════════════════════════
#  Helpers
# ══════════════════════════════════════════════════════════════════════════
def _is_fragrance(trade_name, application):
    hay = f"{trade_name or ''} {application or ''}".lower()
    return any(k in hay for k in FRAGRANCE_KEYWORDS)


# ── Per-user signature directory (mirrors rd_sampling_routes._USER_SIGNATURES) ──
_USER_SIGNATURES = {
    'tarak': {
        'name':        'Tarak Bhavsar',
        'designation': 'SENIOR PURCHASE MANAGER',
        'mobile':      '+91 93 2891 1749',
        'email':       'tarak@hcpwellness.in',
    },
    'admin': {
        'name':        'Tarak Bhavsar',
        'designation': 'SENIOR PURCHASE MANAGER',
        'mobile':      '+91 93 2891 1749',
        'email':       'tarak@hcpwellness.in',
    },
    'sonal': {
        'name':        'Sonal Makwana',
        'designation': 'Purchase Executive',
        'mobile':      '+91 6358 976 126',
        'email':       'sonal@hcpwellness.in',
    },
    'suraj': {
        'name':        'Suraj Khatik',
        'designation': 'Purchase Executive',
        'mobile':      '+91 816 097 5673',
        'email':       'purchase2@hcpwellness.in',
    },
}


def _current_user_signature():
    """Pick signature based on who's logged into the portal session.

    Falls back to Tarak if session is missing or user isn't in the directory.
    """
    uid = (session.get('UID') or session.get('User_Name') or 'tarak').lower()
    sig = _USER_SIGNATURES.get(uid)
    if not sig:
        # Admins, or any unmapped user → Tarak's signature
        sig = _USER_SIGNATURES['tarak']
    return sig


def _build_email_body(row):
    """Warm sample-request email (assumes existing relationship).

    Signature auto-selected from logged-in portal session.
    For cold outreach, user can manually edit before sending.
    """
    sig = _current_user_signature()
    return f"""Dear Sir/Madam,

Greetings from HCP Wellness Pvt. Ltd!

We have a fresh requirement for the following material and would like
to request a sample from you for evaluation:

Trade Name     : {row.get('trade_name','')}
INCI Name      : {row.get('inci','')}
Application    : {row.get('application','')}
Sample Quantity: {row.get('qty','')}
Required By    : {row.get('required_by','')}

Kindly share the sample along with:
- COA and MSDS
- Rate per kg
- MOQ / Lead time / Pack size options

Looking forward to hearing from you.

Thanks & Regards,
{sig['name']}
({sig['designation']})
HCP Wellness Pvt. Ltd
Cell : {sig['mobile']}
Email: {sig['email']}
"""


def _build_subject(row):
    return f"Sample Request - {row.get('trade_name','')} | HCP Wellness Pvt. Ltd"


def _build_whatsapp_body(row):
    """Medium-length WhatsApp sample-request message.

    Uses WhatsApp formatting: *bold*, no heavy HTML. Signature comes from
    the logged-in user so Sonal's messages are signed by Sonal.
    """
    sig = _current_user_signature()
    return f"""Greetings from HCP Wellness!

We need a sample for evaluation:

*Trade Name:* {row.get('trade_name','')}
*INCI:* {row.get('inci','')}
*Application:* {row.get('application','')}
*Qty:* {row.get('qty','')}
*Required By:* {row.get('required_by','')}

Kindly share along with the sample:
- COA & MSDS
- Rate per kg
- MOQ / Lead time / Pack sizes

Looking forward to your response.

{sig['name']}
HCP Wellness Pvt Ltd
{sig['mobile']}"""


# ══════════════════════════════════════════════════════════════════════════
#  ROUTES
# ══════════════════════════════════════════════════════════════════════════
@rd_agent_bp.route('/')
@_login_required
def dashboard_page():
    """Render the dashboard HTML shell. Data loads via fetch()."""
    return render_template(
        'rd_agent_dashboard.html',
        user_name=session.get('User_Name', ''),
        user_type=session.get('User_Type', ''),
        gmail_configured=bool(GMAIL_CREDS and os.path.exists(GMAIL_CREDS)),
        google_search_configured=bool(GSEARCH_KEY and GSEARCH_CX),
        cc_list=CC_LIST,
    )


@rd_agent_bp.route('/api/pending')
@_login_required
def api_pending():
    """Return pending samples enriched with contact-count metadata."""
    conn = sampling_portal.get_db_connection()
    try:
        rows = conn.execute("""
            SELECT id, request_date, trade_name, inci_name AS inci,
                   application, requested_sample_qty AS qty,
                   suggested_supplier, required_by_date AS required_by,
                   status
            FROM   rd_sampling_requests
            WHERE  status = 'Pending'
            ORDER  BY request_date DESC, id DESC
        """).fetchall()
    finally:
        conn.close()

    result = []
    for r in rows:
        r = dict(r)
        # Date normalisation
        for k, v in list(r.items()):
            if hasattr(v, "isoformat"):
                r[k] = v.isoformat()
            elif v is None:
                r[k] = ""
        # Count suppliers contacted from our local log.
        # Each distinct supplier_email counts once — and whatsapp_sent
        # entries use a 'whatsapp:name' pseudo-key so they count too.
        con = sqlite3.connect(LOG_DB)
        count = con.execute("""
            SELECT COUNT(DISTINCT supplier_email)
            FROM   rd_agent_contacts
            WHERE  lower(trade_name) = lower(?)
              AND  action IN ('sent','drafted','opened_in_gmail','whatsapp_sent')
              AND  supplier_email != ''
              AND  created_at > datetime('now','-14 days')
        """, (r['trade_name'],)).fetchone()[0]
        con.close()
        r['contacted_count']   = count
        r['is_fragrance']      = _is_fragrance(r['trade_name'], r['application'])
        r['coverage_status']   = (
            'covered' if count >= 3 else
            'partial' if count >= 1 else
            'none'
        )
        result.append(r)
    return jsonify(result)


# ── Internal domains to EXCLUDE from the supplier thread list ──
# Anyone from these domains is a colleague, not a supplier.
INTERNAL_DOMAINS = ('hcpwellness.in',)

# Known non-supplier email patterns (meeting minutes, internal FYI, etc.)
NON_SUPPLIER_SUBJECT_HINTS = (
    'mom -', 'minutes of meeting', 'meeting notes', 'fyi', 'fwd:', 'forwarded',
    'internal:', 'follow up internal',
)


def _looks_like_supplier_thread(from_addr, subject):
    """Heuristic: True if this thread looks like a real supplier conversation,
    False if it's an internal/own/meeting/FYI thread."""
    email = _extract_email_from_header(from_addr)
    if not email:
        return False
    # Internal domain → not a supplier
    if any(email.endswith('@' + d) or email.endswith('.' + d) for d in INTERNAL_DOMAINS):
        return False
    # MOM / meeting / FYI style subjects → likely not a supplier
    subj_lo = (subject or '').lower()
    if any(hint in subj_lo for hint in NON_SUPPLIER_SUBJECT_HINTS):
        return False
    return True


@rd_agent_bp.route('/api/find_suppliers', methods=['POST'])
@_login_required
def api_find_suppliers():
    """
    For a given trade_name, return:
      1. prior_suppliers  — from our local log (already filtered to real suppliers)
      2. supplier_threads — Gmail threads FROM external supplier addresses
      3. own_outbound     — Gmail threads FROM us (shown separately for reference)
    """
    data = request.json or {}
    trade_name = (data.get('trade_name') or '').strip()
    if not trade_name:
        return jsonify({'status': 'error', 'message': 'trade_name required'}), 400

    # ── 1. From local log ──
    con = sqlite3.connect(LOG_DB)
    con.row_factory = sqlite3.Row
    prior = con.execute("""
        SELECT DISTINCT supplier_name, supplier_email,
               max(created_at)  AS last_contact,
               count(*)         AS n_contacts
        FROM   rd_agent_contacts
        WHERE  lower(trade_name) LIKE lower(?)
          AND  supplier_email != ''
          AND  supplier_email NOT LIKE '%@hcpwellness.in'
        GROUP  BY supplier_email
        ORDER  BY last_contact DESC
        LIMIT  20
    """, (f"%{trade_name}%",)).fetchall()
    con.close()
    prior_list = [dict(r) for r in prior]

    # ── 2. From Gmail (last 60 days, includes replies) ──
    supplier_threads = {}
    own_outbound     = {}
    if _GMAIL_AVAILABLE:
        hits = _gmail_search(
            f'"{trade_name}" sample newer_than:60d',
            max_results=30
        )
        for h in hits:
            tid   = h['threadId']
            email = _extract_email_from_header(h['from'])
            subj  = h.get('subject', '')
            entry = {
                'threadId':       tid,
                'subject':        subj,
                'latest_from':    h['from'],
                'latest_date':    h['date'],
                'snippet':        h['snippet'],
                'supplier_email': email,
            }
            if _looks_like_supplier_thread(h['from'], subj):
                # External supplier — add to supplier list
                if tid not in supplier_threads:
                    supplier_threads[tid] = entry
                else:
                    supplier_threads[tid]['snippet'] = h['snippet']
            else:
                # Internal / own / MOM — show separately for reference
                if tid not in own_outbound:
                    own_outbound[tid] = entry

    return jsonify({
        'prior_suppliers':  prior_list,
        'gmail_threads':    list(supplier_threads.values()),
        'own_outbound':     list(own_outbound.values()),
    })


@rd_agent_bp.route('/api/google_search', methods=['POST'])
@_login_required
def api_google_search():
    """
    Google Custom Search to find new supplier leads.
    Blocked for fragrances/flavours at the API level too (belt and braces).
    """
    if not _REQUESTS_AVAILABLE:
        return jsonify({'status': 'error', 'message': 'requests library not installed'}), 500
    if not GSEARCH_KEY or not GSEARCH_CX:
        return jsonify({'status': 'error',
                        'message': 'Google Custom Search not configured'}), 400

    data = request.json or {}
    trade_name  = (data.get('trade_name') or '').strip()
    application = (data.get('application') or '').strip()
    if not trade_name:
        return jsonify({'status': 'error', 'message': 'trade_name required'}), 400
    if _is_fragrance(trade_name, application):
        return jsonify({
            'status': 'blocked',
            'message': 'Fragrance / flavour — existing suppliers only (company policy).',
            'results': [],
        })

    query = f'"{trade_name}" supplier India email contact'
    try:
        r = _requests.get(
            "https://www.googleapis.com/customsearch/v1",
            params={"key": GSEARCH_KEY, "cx": GSEARCH_CX, "q": query, "num": 8},
            timeout=15,
        )
        r.raise_for_status()
        items = r.json().get("items", [])
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

    JUNK = ("example.com", "sentry.io", "wixpress.com", "cloudflare.com",
            "gstatic.com", "googleapis.com", "w3.org", "schema.org",
            "google.com", "facebook.com", "linkedin.com")

    results, seen = [], set()
    for it in items:
        link    = it.get("link", "")
        title   = it.get("title", "")
        snippet = it.get("snippet", "")
        emails  = [e.lower() for e in _EMAIL_RE.findall(snippet)
                   if not any(j in e.lower() for j in JUNK)]

        key = (link, emails[0] if emails else '')
        if key in seen:
            continue
        seen.add(key)
        results.append({
            'name':    title.split(" - ")[0][:80],
            'website': link,
            'snippet': snippet[:200],
            'email':   emails[0] if emails else '',
        })
    return jsonify({'status': 'ok', 'results': results})


@rd_agent_bp.route('/api/email_preview', methods=['POST'])
@_login_required
def api_email_preview():
    """Return the exact subject + body the dashboard would send."""
    data = request.json or {}
    sig = _current_user_signature()
    return jsonify({
        'subject':    _build_subject(data),
        'body':       _build_email_body(data),
        'cc':         CC_LIST,
        'to':         data.get('supplier_email', ''),
        'signer':     sig['name'],
        'signer_email': sig['email'],
    })


@rd_agent_bp.route('/api/whatsapp_preview', methods=['POST'])
@_login_required
def api_whatsapp_preview():
    """Return the pre-filled WhatsApp message for this sample."""
    data = request.json or {}
    sig = _current_user_signature()
    return jsonify({
        'message': _build_whatsapp_body(data),
        'signer':  sig['name'],
    })


@rd_agent_bp.route('/api/whatsapp_sent', methods=['POST'])
@_login_required
def api_whatsapp_sent():
    """Log that the user clicked 'Open WhatsApp' for a sample.

    No supplier email here — WhatsApp contacts aren't email addresses.
    We log the supplier_name (if provided) so history is still useful.
    Coverage counter treats each WhatsApp send as a contact attempt.
    """
    data = request.json or {}
    _log_contact(
        sample_id      = int(data.get('sample_id') or 0),
        trade_name     = data.get('trade_name', ''),
        supplier_name  = data.get('supplier_name') or 'WhatsApp recipient',
        supplier_email = f"whatsapp:{data.get('supplier_name') or 'unnamed'}",
        action         = 'whatsapp_sent',
    )
    return jsonify({'status': 'logged'})


@rd_agent_bp.route('/api/send_direct', methods=['POST'])
@_login_required
def api_send_direct():
    """Send the email directly via Gmail API."""
    if not _GMAIL_AVAILABLE:
        return jsonify({'status': 'error', 'message': 'Gmail libraries not installed'}), 500
    data = request.json or {}
    to = (data.get('supplier_email') or '').strip()
    if not to or '@' not in to:
        return jsonify({'status': 'error', 'message': 'Valid supplier_email required'}), 400

    subject = _build_subject(data)
    # Allow the user to edit the body in the preview modal before sending
    body = (data.get('custom_body') or '').strip() or _build_email_body(data)

    sig = _current_user_signature()
    try:
        resp = _gmail_send(to, subject, body, cc=CC_LIST,
                           from_addr=sig['email'])
    except Exception as e:
        # If sending as an alias fails (alias not set up in Gmail),
        # fall back to the default authenticated sender.
        try:
            resp = _gmail_send(to, subject, body, cc=CC_LIST)
        except Exception as e2:
            return jsonify({'status': 'error', 'message': str(e2)}), 500

    _log_contact(
        sample_id      = int(data.get('sample_id') or 0),
        trade_name     = data.get('trade_name', ''),
        supplier_name  = data.get('supplier_name', ''),
        supplier_email = to,
        action         = 'sent',
        gmail_msg_id   = resp.get('id'),
    )
    return jsonify({'status': 'sent', 'message_id': resp.get('id')})


@rd_agent_bp.route('/api/mark_opened', methods=['POST'])
@_login_required
def api_mark_opened():
    """
    Called when user clicks 'Open in Gmail compose'.
    We count this as a contact attempt for coverage tracking.
    """
    data = request.json or {}
    to = (data.get('supplier_email') or '').strip()
    _log_contact(
        sample_id      = int(data.get('sample_id') or 0),
        trade_name     = data.get('trade_name', ''),
        supplier_name  = data.get('supplier_name', ''),
        supplier_email = to,
        action         = 'opened_in_gmail',
    )
    return jsonify({'status': 'logged'})


@rd_agent_bp.route('/api/history/<int:sample_id>')
@_login_required
def api_history(sample_id):
    """Return all contacts logged for a given sample."""
    con = sqlite3.connect(LOG_DB)
    con.row_factory = sqlite3.Row
    rows = con.execute("""
        SELECT supplier_name, supplier_email, action, gmail_msg_id,
               user_id, created_at
        FROM   rd_agent_contacts
        WHERE  sample_id = ?
        ORDER  BY created_at DESC
    """, (sample_id,)).fetchall()
    con.close()
    return jsonify([dict(r) for r in rows])
