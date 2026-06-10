"""Fetch pending samples from the R&D Sampling portal.

Preferred: add a JSON endpoint to your portal and use get_pending_via_api().
Fallback: scrape the HTML table with get_pending_via_scrape().
"""
import os, requests
from bs4 import BeautifulSoup   # pip install beautifulsoup4 (only needed for scrape)

BASE = os.environ["PORTAL_BASE_URL"].rstrip("/")
TOKEN = os.environ.get("PORTAL_API_TOKEN", "")

def get_pending_via_api():
    """Recommended. Add /api/rd_sampling/pending to your portal."""
    headers = {"Authorization": f"Bearer {TOKEN}"} if TOKEN else {}
    r = requests.get(f"{BASE}/api/rd_sampling/pending", headers=headers, timeout=15)
    r.raise_for_status()
    return r.json()   # [{id, trade_name, inci, application, qty, suggested_supplier, required_by, req_date}, ...]

def get_pending_via_scrape():
    """Fallback: parse the HTML list page."""
    r = requests.get(f"{BASE}/rd_sampling?status=Pending", timeout=20)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    rows = []
    for tr in soup.select("table tr[data-id]"):
        cells = [td.get_text(strip=True) for td in tr.find_all("td")]
        rows.append({
            "id": int(tr["data-id"]),
            "status": cells[1],
            "req_date": cells[2],
            "trade_name": cells[3],
            "inci": cells[4],
            "application": cells[5],
            "qty": cells[6],
            "suggested_supplier": cells[7],
            "required_by": cells[8],
        })
    return [r for r in rows if r["status"].lower() == "pending"]

def get_pending():
    try:
        return get_pending_via_api()
    except Exception:
        return get_pending_via_scrape()