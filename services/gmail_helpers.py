"""Gmail API wrappers: search, read, send/draft."""
import os, base64
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.compose",
]

def _service():
    creds = None
    tok = os.environ["GMAIL_TOKEN_FILE"]
    cred = os.environ["GMAIL_CREDENTIALS_FILE"]
    if os.path.exists(tok):
        creds = Credentials.from_authorized_user_file(tok, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(cred, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(tok, "w") as f: f.write(creds.to_json())
    return build("gmail", "v1", credentials=creds, cache_discovery=False)

def search_messages(query, max_results=20):
    svc = _service()
    res = svc.users().messages().list(userId="me", q=query, maxResults=max_results).execute()
    out = []
    for m in res.get("messages", []):
        full = svc.users().messages().get(userId="me", id=m["id"], format="metadata",
                                          metadataHeaders=["From","To","Cc","Subject","Date"]).execute()
        headers = {h["name"]: h["value"] for h in full["payload"]["headers"]}
        out.append({
            "id": m["id"], "threadId": full["threadId"], "snippet": full.get("snippet",""),
            "from": headers.get("From",""), "to": headers.get("To",""),
            "cc": headers.get("Cc",""), "subject": headers.get("Subject",""),
            "date": headers.get("Date",""),
        })
    return out

def read_thread(thread_id):
    svc = _service()
    t = svc.users().threads().get(userId="me", id=thread_id, format="full").execute()
    msgs = []
    for m in t["messages"]:
        headers = {h["name"]: h["value"] for h in m["payload"]["headers"]}
        body = _extract_body(m["payload"])
        msgs.append({
            "from": headers.get("From",""), "to": headers.get("To",""),
            "cc": headers.get("Cc",""), "subject": headers.get("Subject",""),
            "date": headers.get("Date",""), "body": body[:4000]
        })
    return msgs

def _extract_body(payload):
    if payload.get("body", {}).get("data"):
        return base64.urlsafe_b64decode(payload["body"]["data"]).decode("utf-8","replace")
    for part in payload.get("parts", []):
        if part.get("mimeType","").startswith("text/plain"):
            data = part.get("body",{}).get("data")
            if data: return base64.urlsafe_b64decode(data).decode("utf-8","replace")
    for part in payload.get("parts", []):
        sub = _extract_body(part)
        if sub: return sub
    return ""

def compose(to, cc, subject, body, sender):
    msg = MIMEText(body, "plain", "utf-8")
    msg["To"] = to
    msg["Cc"] = cc
    msg["From"] = sender
    msg["Subject"] = subject
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
    return {"raw": raw}

def send(to, cc, subject, body, sender):
    svc = _service()
    return svc.users().messages().send(userId="me", body=compose(to,cc,subject,body,sender)).execute()

def create_draft(to, cc, subject, body, sender):
    svc = _service()
    return svc.users().drafts().create(userId="me", body={"message": compose(to,cc,subject,body,sender)}).execute()