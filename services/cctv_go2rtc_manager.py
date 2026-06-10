"""
cctv_go2rtc_manager.py — go2rtc lifecycle helpers
==================================================

Provides:
  • detect_go2rtc()          → {'installed': bool, 'running': bool, 'path': str, 'version': str, 'streams': int}
  • install_go2rtc()         → downloads + extracts go2rtc_win64.zip from GitHub
  • write_config_from_db()   → generates go2rtc.yaml from the cctv_recorders/cameras tables
  • start_go2rtc()           → launches go2rtc.exe as a background process (Popen)
  • stop_go2rtc()            → kills any running go2rtc process

  Service install is exposed as a downloadable .bat file that the user
  runs once with Right-click → Run as administrator (NSSM-based).

All of this assumes a Windows host. On Linux the server-side functions
fall back to printing a hint — install go2rtc manually.
"""

import os
import sys
import json
import time
import shutil
import socket
import zipfile
import platform
import subprocess
from urllib.request import urlopen, Request
from urllib.error import URLError

# ─────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────
# Where go2rtc lives on this machine. C:\go2rtc is the convention used by the
# README and recommended in the go2rtc docs. If the user wants to put it
# elsewhere, they can edit this constant or set GO2RTC_DIR env var.
GO2RTC_DIR = os.environ.get('GO2RTC_DIR', r'C:\go2rtc')
GO2RTC_EXE = os.path.join(GO2RTC_DIR, 'go2rtc.exe')
GO2RTC_YAML = os.path.join(GO2RTC_DIR, 'go2rtc.yaml')
GO2RTC_LOG  = os.path.join(GO2RTC_DIR, 'go2rtc.log')

# Latest Windows 64-bit binary direct download. The "latest" redirect always
# follows GitHub's most recent release.
GO2RTC_DOWNLOAD_URL = "https://github.com/AlexxIT/go2rtc/releases/latest/download/go2rtc_win64.zip"

# Local API for status / control
GO2RTC_API_HOST = '127.0.0.1'
GO2RTC_API_PORT = 1984
GO2RTC_API_BASE = f"http://{GO2RTC_API_HOST}:{GO2RTC_API_PORT}"


def _is_windows() -> bool:
    return platform.system().lower().startswith('win')


# ─────────────────────────────────────────────────────────────────────────────
# Detection
# ─────────────────────────────────────────────────────────────────────────────
def _is_port_open(host: str, port: int, timeout: float = 1.0) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect((host, port))
        return True
    except Exception:
        return False
    finally:
        s.close()


def _http_get_json(url: str, timeout: float = 2.0):
    try:
        req = Request(url, headers={'User-Agent': 'HCP-Portal/1.0'})
        with urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode('utf-8'))
    except Exception:
        return None


def detect_go2rtc() -> dict:
    """
    Returns a dict describing the current state of go2rtc on this host.

    Keys:
      installed       — go2rtc.exe exists on disk
      running         — TCP probe on port 1984 succeeds
      path            — full path to go2rtc.exe (whether or not it exists)
      yaml_path       — full path to the config file
      version         — go2rtc version string (only when running)
      streams         — count of configured streams (only when running)
      service_status  — 'running'/'stopped'/'not_installed' for the Windows service
    """
    out = {
        'installed':       os.path.exists(GO2RTC_EXE),
        'running':         _is_port_open(GO2RTC_API_HOST, GO2RTC_API_PORT, 1.0),
        'path':            GO2RTC_EXE,
        'yaml_path':       GO2RTC_YAML,
        'yaml_exists':     os.path.exists(GO2RTC_YAML),
        'version':         '',
        'streams':         0,
        'service_status':  'not_installed',
        'platform':        platform.system(),
    }

    if out['running']:
        info = _http_get_json(f"{GO2RTC_API_BASE}/api")
        if info:
            out['version'] = info.get('version') or info.get('config_path') or ''
        streams = _http_get_json(f"{GO2RTC_API_BASE}/api/streams")
        if isinstance(streams, dict):
            out['streams'] = len(streams)
        elif isinstance(streams, list):
            out['streams'] = len(streams)

    if _is_windows():
        out['service_status'] = _query_service_status('go2rtc')

    return out


def _query_service_status(svc_name: str) -> str:
    """sc query <name> → parse STATE line."""
    if not _is_windows():
        return 'not_installed'
    try:
        r = subprocess.run(
            ['sc', 'query', svc_name],
            capture_output=True, text=True, timeout=5
        )
        out = (r.stdout or '') + (r.stderr or '')
        if 'does not exist' in out.lower() or 'not exist' in out.lower():
            return 'not_installed'
        if 'RUNNING' in out:
            return 'running'
        if 'STOPPED' in out:
            return 'stopped'
        return 'unknown'
    except Exception:
        return 'unknown'


# ─────────────────────────────────────────────────────────────────────────────
# Install
# ─────────────────────────────────────────────────────────────────────────────
def install_go2rtc(progress_cb=None) -> dict:
    """
    Download go2rtc_win64.zip and extract go2rtc.exe to GO2RTC_DIR.

    Returns: {ok: bool, path: str, error: str?}
    progress_cb (optional): callable receiving status strings for streaming UIs.
    """
    if not _is_windows():
        return {'ok': False, 'error': 'Auto-install only supported on Windows. '
                'On Linux/Mac, download go2rtc manually from '
                'https://github.com/AlexxIT/go2rtc/releases/latest'}

    def _log(msg):
        print(f"[go2rtc-install] {msg}")
        if progress_cb:
            progress_cb(msg)

    try:
        os.makedirs(GO2RTC_DIR, exist_ok=True)
        zip_path = os.path.join(GO2RTC_DIR, 'go2rtc_win64.zip')

        _log(f"Downloading from {GO2RTC_DOWNLOAD_URL} …")
        req = Request(GO2RTC_DOWNLOAD_URL, headers={'User-Agent': 'HCP-Portal/1.0'})
        with urlopen(req, timeout=60) as r, open(zip_path, 'wb') as f:
            total = int(r.headers.get('Content-Length') or 0)
            done = 0
            chunk = 64 * 1024
            while True:
                buf = r.read(chunk)
                if not buf: break
                f.write(buf)
                done += len(buf)
                if total:
                    pct = int(done * 100 / total)
                    if pct % 10 == 0:
                        _log(f"…{pct}% ({done//1024} KB / {total//1024} KB)")

        _log(f"Extracting {zip_path} …")
        with zipfile.ZipFile(zip_path, 'r') as z:
            # Extract only go2rtc.exe to avoid clutter
            for member in z.namelist():
                if member.lower().endswith('go2rtc.exe'):
                    with z.open(member) as src, open(GO2RTC_EXE, 'wb') as dst:
                        shutil.copyfileobj(src, dst)
                    break
            else:
                return {'ok': False, 'error': 'go2rtc.exe not found in zip'}

        try:
            os.remove(zip_path)
        except Exception:
            pass

        if not os.path.exists(GO2RTC_EXE):
            return {'ok': False, 'error': 'extraction completed but go2rtc.exe missing'}

        _log(f"Installed: {GO2RTC_EXE}")
        return {'ok': True, 'path': GO2RTC_EXE}

    except URLError as e:
        return {'ok': False, 'error': f'download failed (no internet?): {e}'}
    except PermissionError as e:
        return {'ok': False, 'error': f'permission denied (try admin): {e}'}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


# ─────────────────────────────────────────────────────────────────────────────
# Config generation
# ─────────────────────────────────────────────────────────────────────────────
def write_config_from_db(get_db_connection, build_rtsp_url) -> dict:
    """
    Generate go2rtc.yaml by reading active recorders+cameras from MySQL.

    Args:
      get_db_connection — function returning a portal DB connection
      build_rtsp_url    — function from cctv_routes to build the URL
    """
    conn = get_db_connection()
    if not conn:
        return {'ok': False, 'error': 'DB connection failed'}
    try:
        rows = conn.execute("""
            SELECT c.id, c.channel, c.name, c.is_active,
                   r.ip, r.rtsp_port, r.username, r.password_enc,
                   r.encryption_key_enc, r.rtsp_template
            FROM cctv_cameras c JOIN cctv_recorders r ON r.id = c.recorder_id
            WHERE c.is_active = 1 AND r.is_active = 1
            ORDER BY c.id
        """).fetchall()

        lines = [
            "# Auto-generated by HCP portal — do not edit by hand.",
            "# Regenerate via /cctv/admin → go2rtc tab → Sync Config.",
            "api:",
            "  listen: \":1984\"",
            "rtsp:",
            "  listen: \":8554\"",
            "webrtc:",
            "  listen: \":8555\"",
            "log:",
            "  level: info",
            "streams:",
        ]
        for row in rows:
            r = dict(row)
            main = build_rtsp_url(r, r['channel'], 'main')
            sub  = build_rtsp_url(r, r['channel'], 'sub')
            lines.append(f"  cam_{r['id']}_main: {main}")
            lines.append(f"  cam_{r['id']}_sub:  {sub}")

        os.makedirs(GO2RTC_DIR, exist_ok=True)
        with open(GO2RTC_YAML, 'w', encoding='utf-8') as f:
            f.write("\n".join(lines) + "\n")
        return {'ok': True, 'path': GO2RTC_YAML, 'streams': len(rows)}
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# Start / stop
# ─────────────────────────────────────────────────────────────────────────────
def start_go2rtc() -> dict:
    """
    Launch go2rtc.exe as a detached background process. The process keeps
    running after Flask exits (DETACHED_PROCESS). stdout is redirected to
    GO2RTC_LOG so you can read it from the admin UI.
    """
    if not _is_windows():
        return {'ok': False, 'error': 'start_go2rtc only on Windows; use systemd otherwise'}
    if not os.path.exists(GO2RTC_EXE):
        return {'ok': False, 'error': 'go2rtc.exe not installed'}
    if _is_port_open(GO2RTC_API_HOST, GO2RTC_API_PORT, 1.0):
        return {'ok': True, 'message': 'already running'}

    try:
        # CREATE_NO_WINDOW + DETACHED_PROCESS = no console pop-up, survives parent exit
        DETACHED_PROCESS    = 0x00000008
        CREATE_NEW_PG       = 0x00000200
        flags = DETACHED_PROCESS | CREATE_NEW_PG | subprocess.CREATE_NO_WINDOW

        log_f = open(GO2RTC_LOG, 'a', encoding='utf-8')
        log_f.write(f"\n\n--- started by HCP portal at {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n")
        log_f.flush()

        subprocess.Popen(
            [GO2RTC_EXE, '-c', GO2RTC_YAML],
            cwd=GO2RTC_DIR,
            stdout=log_f,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            creationflags=flags,
            close_fds=True,
        )

        # Wait up to 5s for it to come up
        for _ in range(10):
            time.sleep(0.5)
            if _is_port_open(GO2RTC_API_HOST, GO2RTC_API_PORT, 0.5):
                return {'ok': True, 'message': 'started'}
        return {'ok': False, 'error': 'started but API port did not open in 5s — check go2rtc.log'}

    except Exception as e:
        return {'ok': False, 'error': str(e)}


def stop_go2rtc() -> dict:
    """Kill go2rtc.exe via taskkill. Affects only this user's processes."""
    if not _is_windows():
        return {'ok': False, 'error': 'stop_go2rtc only on Windows'}
    try:
        r = subprocess.run(
            ['taskkill', '/F', '/IM', 'go2rtc.exe'],
            capture_output=True, text=True, timeout=10
        )
        if r.returncode == 0 or 'not found' in (r.stderr or '').lower():
            return {'ok': True}
        return {'ok': False, 'error': r.stderr or r.stdout}
    except Exception as e:
        return {'ok': False, 'error': str(e)}


# ─────────────────────────────────────────────────────────────────────────────
# Service install helper — generates a .bat file the user runs as admin
# ─────────────────────────────────────────────────────────────────────────────
def generate_service_install_bat() -> str:
    """
    Returns the contents of a .bat file that, when run as administrator:
      1. Downloads NSSM if not present
      2. Installs go2rtc as a Windows Service
      3. Configures it to auto-start at boot
      4. Adds firewall rules for ports 1984, 8554, 8555

    The user downloads this via the admin UI and right-clicks → Run as admin.
    """
    return r'''@echo off
REM ──────────────────────────────────────────────────────────────────────────
REM  HCP Portal — go2rtc Windows Service installer
REM
REM  RUN AS ADMINISTRATOR (right-click → Run as administrator)
REM ──────────────────────────────────────────────────────────────────────────

setlocal enabledelayedexpansion

set "GO2RTC_DIR=''' + GO2RTC_DIR + r'''"
set "GO2RTC_EXE=%GO2RTC_DIR%\go2rtc.exe"
set "NSSM_EXE=%GO2RTC_DIR%\nssm.exe"
set "NSSM_URL=https://nssm.cc/release/nssm-2.24.zip"

echo.
echo ========================================
echo   HCP go2rtc Service Installer
echo ========================================
echo.

REM Check elevation
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] This script must be run as Administrator.
    echo         Right-click the .bat file and select "Run as administrator".
    pause
    exit /b 1
)

if not exist "%GO2RTC_EXE%" (
    echo [ERROR] go2rtc.exe not found at %GO2RTC_EXE%
    echo         Install go2rtc first via the portal admin page.
    pause
    exit /b 1
)

REM ── 1. Download NSSM if missing ───────────────────────────────────────────
if not exist "%NSSM_EXE%" (
    echo [1/4] Downloading NSSM...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$ErrorActionPreference='Stop'; Invoke-WebRequest -Uri '%NSSM_URL%' -OutFile '%TEMP%\nssm.zip'"
    if errorlevel 1 (
        echo [ERROR] Failed to download NSSM. Get it manually from https://nssm.cc/download
        pause
        exit /b 1
    )
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "Expand-Archive -Force '%TEMP%\nssm.zip' '%TEMP%\nssm-extract'"
    copy /Y "%TEMP%\nssm-extract\nssm-2.24\win64\nssm.exe" "%NSSM_EXE%" >nul
    del "%TEMP%\nssm.zip" >nul 2>&1
    rmdir /S /Q "%TEMP%\nssm-extract" >nul 2>&1
    echo       NSSM installed at %NSSM_EXE%
) else (
    echo [1/4] NSSM already present.
)

REM ── 2. Remove existing service if present ────────────────────────────────
echo [2/4] Removing any existing go2rtc service...
"%NSSM_EXE%" stop   go2rtc >nul 2>&1
"%NSSM_EXE%" remove go2rtc confirm >nul 2>&1

REM ── 3. Install go2rtc service ─────────────────────────────────────────────
echo [3/4] Installing go2rtc service...
"%NSSM_EXE%" install go2rtc "%GO2RTC_EXE%"
"%NSSM_EXE%" set go2rtc AppDirectory "%GO2RTC_DIR%"
"%NSSM_EXE%" set go2rtc AppParameters "-c go2rtc.yaml"
"%NSSM_EXE%" set go2rtc AppStdout "%GO2RTC_DIR%\go2rtc.log"
"%NSSM_EXE%" set go2rtc AppStderr "%GO2RTC_DIR%\go2rtc.log"
"%NSSM_EXE%" set go2rtc AppRotateFiles 1
"%NSSM_EXE%" set go2rtc AppRotateBytes 10485760
"%NSSM_EXE%" set go2rtc Start SERVICE_AUTO_START
"%NSSM_EXE%" set go2rtc Description "go2rtc — RTSP/WebRTC streaming gateway for HCP Portal CCTV"

REM ── 4. Open firewall ports ────────────────────────────────────────────────
echo [4/4] Opening firewall ports 1984, 8554, 8555...
netsh advfirewall firewall delete rule name="HCP go2rtc API"   >nul 2>&1
netsh advfirewall firewall delete rule name="HCP go2rtc RTSP"  >nul 2>&1
netsh advfirewall firewall delete rule name="HCP go2rtc WebRTC TCP" >nul 2>&1
netsh advfirewall firewall delete rule name="HCP go2rtc WebRTC UDP" >nul 2>&1
netsh advfirewall firewall add rule name="HCP go2rtc API"       dir=in action=allow protocol=TCP localport=1984 profile=any
netsh advfirewall firewall add rule name="HCP go2rtc RTSP"      dir=in action=allow protocol=TCP localport=8554 profile=any
netsh advfirewall firewall add rule name="HCP go2rtc WebRTC TCP" dir=in action=allow protocol=TCP localport=8555 profile=any
netsh advfirewall firewall add rule name="HCP go2rtc WebRTC UDP" dir=in action=allow protocol=UDP localport=8555 profile=any

REM ── Start it ──────────────────────────────────────────────────────────────
echo.
echo Starting go2rtc service...
"%NSSM_EXE%" start go2rtc

echo.
echo ========================================
echo   Done. Service is installed and running.
echo   It will auto-start on every reboot.
echo ========================================
echo.
echo   Manage with:
echo     services.msc
echo     %NSSM_EXE% restart go2rtc
echo     %NSSM_EXE% stop    go2rtc
echo.

pause
'''


def generate_service_uninstall_bat() -> str:
    return r'''@echo off
REM ── HCP go2rtc Service Uninstaller — RUN AS ADMINISTRATOR ──

net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Run this as Administrator.
    pause
    exit /b 1
)

set "NSSM_EXE=''' + GO2RTC_DIR + r'''\nssm.exe"

if exist "%NSSM_EXE%" (
    "%NSSM_EXE%" stop   go2rtc >nul 2>&1
    "%NSSM_EXE%" remove go2rtc confirm
) else (
    sc stop   go2rtc >nul 2>&1
    sc delete go2rtc
)

netsh advfirewall firewall delete rule name="HCP go2rtc API"        >nul 2>&1
netsh advfirewall firewall delete rule name="HCP go2rtc RTSP"       >nul 2>&1
netsh advfirewall firewall delete rule name="HCP go2rtc WebRTC TCP" >nul 2>&1
netsh advfirewall firewall delete rule name="HCP go2rtc WebRTC UDP" >nul 2>&1

echo Done.
pause
'''


# ─────────────────────────────────────────────────────────────────────────────
# Log tail — for the UI
# ─────────────────────────────────────────────────────────────────────────────
def tail_log(lines: int = 50) -> str:
    """Return the last N lines of go2rtc.log."""
    if not os.path.exists(GO2RTC_LOG):
        return '(no log yet — go2rtc may not have run from the portal)'
    try:
        with open(GO2RTC_LOG, 'r', encoding='utf-8', errors='replace') as f:
            data = f.readlines()
        return ''.join(data[-lines:])
    except Exception as e:
        return f'(error reading log: {e})'
