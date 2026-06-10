# HCP CCTV Module — Phase 1 Setup

This adds a CCTV live-wall module to the portal. Phase 1 covers everything
**except the AI worker** (that is Phase 2). After Phase 1 you'll have:

- A page at `/cctv` showing a 9-tile (or 4 / 1) live grid, group-selectable
- Per-user camera groups + admin-shared groups
- Playback (Hikvision time-range RTSP) at `/cctv/playback`
- Admin page at `/cctv/admin` to manage DVR/NVR + cameras
- A "CCTV" card on `index.html` visible to all logged-in users

---

## 1 · Files to drop in

```
project_root/
├─ cctv_routes.py                 ← new (blueprint)
├─ cctv_schema.sql                ← new (reference; tables auto-created on app start)
├─ templates/
│   ├─ cctv_live_wall.html        ← new
│   ├─ cctv_admin.html            ← new
│   ├─ cctv_groups.html           ← new
│   └─ cctv_playback.html         ← new
└─ app.py                         ← edit (add 3 lines, see §2)

index.html  ← edit (add card link, see §3)
```

---

## 2 · `app.py` integration

**Add to imports section (around line 41, with the other blueprint imports):**

```python
from cctv_routes import cctv_bp, ensure_cctv_tables       # CCTV Module
```

**Add to the blueprint registration block (around line 65, after the others):**

```python
ensure_cctv_tables()                          # Create cctv_* tables on first run
app.register_blueprint(cctv_bp)               # CCTV routes
```

That's all. The module is self-contained.

---

## 3 · `index.html` — add the CCTV card

Inside the `<div class="kpi-grid">` block in the **Operations** section
(around line 391–531), add this card. It has **no role guard** so every
logged-in user sees it:

```html
<a class="kpi-card cyan" href="/cctv">
  <span class="kc-arrow">→</span>
  <span class="kc-icon">📹</span>
  <div class="kc-label">Security · Surveillance</div>
  <div class="kc-title">CCTV Live Wall</div>
  <div class="kc-sub">Live cameras, groups & playback — DVR/NVR feeds</div>
  <div class="kc-badge live">Live</div>
</a>
```

Pick whichever color slot fits — `cyan`, `indigo`, `purple`, `rose` all work
with your existing theme. I used `cyan` to differentiate from the production
modules.

---

## 4 · go2rtc — RTSP transcoder (one-time setup)

The browser cannot play RTSP directly. **go2rtc** converts the Hikvision RTSP
streams to WebRTC for the browser. Install once on the PC that will run the
streams (any PC on the LAN — the portal server, a worker PC, anything).

### Install on Windows

1. Download the latest Windows binary from the go2rtc GitHub release page
   (e.g. `go2rtc_win64.zip`). Extract to `C:\go2rtc\`.
2. Generate the config from the portal:
   - Log in as admin → `http://192.168.2.91/cctv/admin` → **go2rtc Config** tab
   - Click **Regenerate**, copy the YAML
   - Paste into `C:\go2rtc\go2rtc.yaml`
3. Run once to test: open command prompt in `C:\go2rtc\` and run `go2rtc.exe`.
   Watch the log — you should see each `cam_N_main` and `cam_N_sub` connect.
4. Make it a service. Easiest is **NSSM**:
   ```
   nssm install go2rtc "C:\go2rtc\go2rtc.exe"
   nssm set     go2rtc AppDirectory "C:\go2rtc"
   nssm start   go2rtc
   ```
5. Open the firewall on TCP/UDP **1984** (HTTP API + WebRTC signaling) and
   UDP **8555** (WebRTC media). For LAN-only access, restrict to your subnet.

### How the portal reaches go2rtc

`cctv_routes.py` proxies requests to `http://127.0.0.1:1984` by default. **If
go2rtc runs on a different PC than Flask**, change this line in
`cctv_routes.py`:

```python
GO2RTC_BASE = "http://192.168.2.45:1984"   # ← your go2rtc PC's LAN IP
```

For best performance (lowest latency), set `GO2RTC_HOST` in
`cctv_live_wall.html` to point browsers **directly** at go2rtc:

```js
const GO2RTC_HOST = 'http://192.168.2.45:1984';
```

This bypasses the Flask proxy for video data.

---

## 5 · Permissions model

| Action                            | Who can do it          |
|-----------------------------------|------------------------|
| View live wall (`/cctv`)          | Any logged-in user     |
| View playback (`/cctv/playback`)  | Any logged-in user     |
| Create / edit own groups          | Any logged-in user     |
| Create **shared** groups          | Admin only             |
| Manage recorders, cameras         | Admin only (`/cctv/admin`) |
| See raw RTSP URLs (with passwords)| Admin only             |

Passwords are XOR-obfuscated in the DB using the same scheme as
`tally_credentials` (see `_obfuscate` in `app.py`). Not bank-grade but
prevents casual exposure if someone reads the DB.

---

## 6 · First-time use

1. **Add a recorder** (`/cctv/admin` → Recorders → Add)
   - Enter NVR/DVR IP, credentials, channel count
   - The system auto-creates a camera row per channel
2. **Tune cameras** (`/cctv/admin` → Cameras tab)
   - Rename channels meaningfully (e.g. "Packing Floor East")
   - Set Department, Location, Active flag
3. **Generate go2rtc config** (`/cctv/admin` → go2rtc Config → Regenerate)
   - Copy YAML to `C:\go2rtc\go2rtc.yaml` and restart the service
4. **Create a group** (`/cctv/groups`)
   - Drag cameras into the group, save
5. **View** (`/cctv`)
   - Pick group from dropdown → 9-tile grid loads → arrow keys to page

---

## 7 · Hikvision RTSP URL reference

Modern firmware (NVRs and most current DVRs):
```
rtsp://user:pass@<ip>:554/Streaming/Channels/<ch>01     ← main stream
rtsp://user:pass@<ip>:554/Streaming/Channels/<ch>02     ← sub stream
```

Legacy DVR firmware (set "RTSP Style" to `legacy` in the recorder form):
```
rtsp://user:pass@<ip>:554/h264/ch<ch>/main/av_stream
rtsp://user:pass@<ip>:554/h264/ch<ch>/sub/av_stream
```

Playback (modern only, used by `/cctv/playback`):
```
rtsp://user:pass@<ip>:554/Streaming/tracks/<ch>01?starttime=YYYYMMDDThhmmssZ&endtime=YYYYMMDDThhmmssZ
```

The channel number is **2 digits** in modern URLs (`0101`, `1601`, etc.).
The blueprint handles padding automatically.

---

## 8 · Capacity notes

- 240 channels total (3×64 + 16 + 32 + 32) is well within go2rtc's range,
  but only sub-streams (~CIF, low bitrate) should be used for the grid.
  Main streams are reserved for fullscreen + playback.
- A single browser tab playing 9 sub-streams over WebRTC uses ~30–80 MB RAM
  and ~10–20% of one CPU core.
- The NVR/DVR has its own RTSP client limit — Hikvision typically allows
  10–32 concurrent streams per device. go2rtc opens one connection per
  configured stream regardless of how many browsers are watching, which is
  much kinder to the recorder than letting each browser open its own RTSP.

---

## 9 · What's next (Phase 2 — AI worker)

Once Phase 1 is up and you've added the recorders + identified which cameras
need AI (cameras you toggle `ai_enabled=1`), the next module will:

- Be a separate Python script (`cctv_worker.py`) running as a Windows service
- Read camera list + zones from MySQL
- Pull MJPEG snapshots from go2rtc every 3–5 seconds
- Run YOLOv8n person detection
- Apply zone polygons + idle/empty rules
- Write events to `cctv_events`
- (Optional) push WhatsApp alerts on critical events

Tell me when Phase 1 is running and we'll do Phase 2.
