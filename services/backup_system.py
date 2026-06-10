"""
backup_system.py  –  HCP Portal · Enhanced Backup System
══════════════════════════════════════════════════════════
Handles:
  1. MySQL database dump       (mysqldump  →  .sql.gz)
  2. Web-app folder ZIP        (app root   →  .zip)
  3. Replicate both backups to multiple configured destinations
  4. Autonomous scheduled tasks (APScheduler – wired in app.py)
  5. Manual trigger via Flask API
  6. Full per-backup status log stored in MySQL
  7. Auto-prune: keep only the latest 3 backups per type in EVERY destination

── BACKUP DESTINATIONS ──────────────────────────────────────────────────────
  All destination paths are read live from the `backup_config` MySQL table.
  On this Linux deployment they should be absolute paths OUTSIDE the app
  directory, e.g.:
    PRIMARY   : /var/backups/hcp/primary
    SECONDARY : /var/backups/hcp/secondary
─────────────────────────────────────────────────────────────────────────────
"""

import os
import re
import gzip
import shutil
import zipfile
import subprocess
import traceback
from datetime import datetime, timedelta

# ─────────────────────────────────────────────────────────────────────────────
# ❶  CONFIGURATION  ← all backup paths are now read from the DB at runtime
# ─────────────────────────────────────────────────────────────────────────────
#
# IMPORTANT: There are NO hardcoded backup paths in this module anymore.
# All three paths (Primary / Secondary / Network) are read live
# from the `backup_config` MySQL table via sampling_portal.get_backup_config().
#
# The admin must configure all three paths in the Backup Manager dashboard
# before any backup can run. If any path is missing, run_full_backup() will
# fail fast with a clear error message — no silent fallback to default paths.
# ─────────────────────────────────────────────────────────────────────────────

# Source folder to ZIP on every backup run.
# This is the application root — the folder containing app.py itself.
# Computed at import-time, not hardcoded, so it works regardless of where the
# app is deployed.
SOURCE_APP_FOLDER = os.path.dirname(os.path.abspath(__file__))


def _load_paths() -> dict:
    """
    Read the live admin-configured backup paths from the DB.
    Returns a dict with keys: primary_path, drive_d_path, network_path.

    Imported lazily inside the function to avoid a circular import at module
    load time (sampling_portal also imports backup_system in some flows).
    """
    import sampling_portal
    return sampling_portal.get_backup_config()


def _get_primary_dir() -> str:
    """
    Return the admin-configured primary backup directory at runtime.
    Raises ValueError (via sampling_portal.get_backup_config) if not set.
    """
    return _load_paths()["primary_path"]


def _get_extra_destinations() -> list[dict]:
    """
    Return the list of EXTRA (mirror) destinations at runtime — i.e. every
    configured path EXCEPT the primary. Each entry is {"name", "path"}.

    A destination is included only if its path is non-empty. So if the admin
    leaves Drive D blank, no copy to Drive D is attempted. Same for network.
    This matches the requirement: "take backup on the selected paths only,
    either it is 1 or 2 or 3".
    """
    cfg = _load_paths()
    extras = []
    if cfg.get("drive_d_path"):
        extras.append({"name": "Secondary Backup", "path": cfg["drive_d_path"]})
    if cfg.get("network_path"):
        extras.append({"name": "Network / Third Copy", "path": cfg["network_path"]})
    return extras


# ── Module-level dynamic attributes ────────────────────────────────────────
# Some legacy callers (e.g. older app.py snippets) reference
# `backup_system.PRIMARY_BACKUP_DIR` or `backup_system.BACKUP_DESTINATIONS`
# as if they were module constants. Expose them as dynamic attributes via
# PEP 562 __getattr__ so those references still resolve to live values
# instead of stale hardcoded strings.
def __getattr__(name):
    if name == "PRIMARY_BACKUP_DIR":
        return _get_primary_dir()
    if name == "BACKUP_DESTINATIONS":
        return _get_extra_destinations()
    raise AttributeError(f"module 'backup_system' has no attribute {name!r}")


# Keep the latest N backups (per file type, per destination); delete the rest.
# Each backup run produces one .sql.gz (DB) and one .zip (app folder), so
# keeping 3 of each type retains the 3 most recent backup runs.
PRUNE_KEEP_LATEST = 3

# MySQL connection – imported from sampling_portal so there is a SINGLE source
# of truth for the credentials. Previously these were re-declared here with a
# stale password, which silently broke all DB logging (blank Activity Log).
# If the import fails for any reason, fall back to sane defaults.
try:
    from sampling_portal import (
        DB_HOST as DB_HOST,
        DB_PORT as DB_PORT,
        DB_USER as DB_USER,
        DB_PASSWORD as DB_PASSWORD,
        DB_NAME as DB_NAME,
    )
except Exception:
    DB_HOST     = "localhost"
    DB_PORT     = 3306
    DB_USER     = "root"
    DB_PASSWORD = ""        # intentionally blank — real value comes from sampling_portal
    DB_NAME     = "hcp_portal"

# ── mysqldump / mysql executable path ─────────────────────────────────────────
# Leave as None to auto-detect. On Linux, the binaries are normally on PATH
# (installed via `apt install mysql-client` or `mysql-server`), so shutil.which
# finds them. Or set explicitly, e.g.: "/usr/bin/mysqldump"
MYSQLDUMP_PATH = None
MYSQL_PATH     = None

def _find_mysql_bin(exe: str) -> str:
    """
    Return the full path to a MySQL binary (mysqldump or mysql).
    Search order:
      1. Explicit override (MYSQLDUMP_PATH / MYSQL_PATH)
      2. System PATH  (the normal case on Linux)
      3. Common Linux install locations
    Raises FileNotFoundError if not found anywhere.
    """
    import shutil as _shutil

    # 1. Explicit override
    override = MYSQLDUMP_PATH if exe == "mysqldump" else MYSQL_PATH
    if override:
        if os.path.isfile(override):
            return override
        raise FileNotFoundError(f"Configured path not found: {override}")

    # 2. On system PATH (works on a standard Ubuntu install)
    found = _shutil.which(exe)
    if found:
        return found

    # 3. Scan common Linux install directories (incl. MariaDB)
    candidates = [
        "/usr/bin",
        "/usr/local/bin",
        "/usr/local/mysql/bin",
        "/opt/mysql/bin",
        "/bin",
    ]
    for folder in candidates:
        full = os.path.join(folder, exe)
        if os.path.isfile(full):
            print(f"[Backup] ✅ Found {exe} at: {full}")
            return full

    raise FileNotFoundError(
        f"'{exe}' not found. Install it with 'sudo apt install mysql-client', "
        f"add the MySQL bin folder to PATH, or set MYSQLDUMP_PATH / MYSQL_PATH "
        f"in backup_system.py"
    )


# ─────────────────────────────────────────────────────────────────────────────
# ❷  DB HELPER  (thin wrapper – does NOT depend on sampling_portal)
# ─────────────────────────────────────────────────────────────────────────────

def _get_conn():
    import pymysql, pymysql.cursors
    return pymysql.connect(
        host=DB_HOST, port=DB_PORT,
        user=DB_USER, password=DB_PASSWORD,
        database=DB_NAME,
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=False,
    )


def _ensure_log_table():
    try:
        conn = _get_conn()
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS backup_log (
                    id            INT AUTO_INCREMENT PRIMARY KEY,
                    run_id        VARCHAR(30)  NOT NULL,
                    backup_type   VARCHAR(20)  NOT NULL COMMENT 'db | appzip | copy',
                    triggered_by  VARCHAR(50)  NOT NULL DEFAULT 'auto',
                    filename      VARCHAR(300) NOT NULL DEFAULT '',
                    destination   VARCHAR(300) NOT NULL DEFAULT 'primary',
                    size_kb       FLOAT        NOT NULL DEFAULT 0,
                    status        VARCHAR(20)  NOT NULL DEFAULT 'ok',
                    message       TEXT,
                    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
            """)
        conn.commit()
        conn.close()
    except Exception:
        pass


_ensure_log_table()


def _log(run_id, backup_type, triggered_by, filename, destination, size_kb, status, message=""):
    try:
        conn = _get_conn()
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO backup_log
                    (run_id, backup_type, triggered_by, filename, destination, size_kb, status, message)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """, (run_id, backup_type, triggered_by, filename, destination, size_kb, status, message[:2000]))
        conn.commit()
        conn.close()
    except Exception:
        pass  # never let logging kill the backup process


# ─────────────────────────────────────────────────────────────────────────────
# ❸  DIRECTORY HELPERS
# ─────────────────────────────────────────────────────────────────────────────

def _ensure_dir(path: str) -> bool:
    """Create directory if missing. Returns True on success."""
    try:
        os.makedirs(path, exist_ok=True)
        return True
    except Exception as e:
        print(f"[Backup] ⚠️  Cannot create directory '{path}': {e}")
        return False


def _all_destinations() -> list[dict]:
    """
    Primary dir + all configured extra destinations.
    Reads paths live from the DB via _load_paths(), so any path the admin
    has not configured is simply omitted.
    """
    cfg = _load_paths()
    out = [{"name": "Primary (Server Local)", "path": cfg["primary_path"]}]
    out.extend(_get_extra_destinations())
    return out


# ─────────────────────────────────────────────────────────────────────────────
# ❹  PRUNE  –  delete files older than PRUNE_AFTER_DAYS from every destination
# ─────────────────────────────────────────────────────────────────────────────

def prune_old_backups():
    """
    Keep only the latest PRUNE_KEEP_LATEST backups of each type
    (.sql.gz DB dumps and .zip app folders) in EVERY destination; delete the
    rest. Each backup run produces one of each type, so keeping 3 of each
    retains the 3 most recent runs.

    Returns 0 silently if paths aren't configured yet — pruning shouldn't
    error out the dashboard.
    """
    total_deleted = 0

    try:
        all_dests = _all_destinations()
    except Exception as e:
        print(f"[Backup] ⏭️  Skipping prune — paths not configured ({e})")
        return 0

    for dest in all_dests:
        dpath = dest["path"]
        if not dpath or not os.path.isdir(dpath):
            continue

        # Bucket files by type so each type keeps its own latest N.
        buckets = {"db": [], "app": []}
        for fname in os.listdir(dpath):
            if fname.endswith(".sql.gz"):
                kind = "db"
            elif fname.endswith(".zip"):
                kind = "app"
            else:
                continue
            fpath = os.path.join(dpath, fname)
            try:
                mtime = datetime.fromtimestamp(os.path.getmtime(fpath))
                buckets[kind].append((mtime, fpath, fname))
            except Exception:
                pass

        for kind, candidates in buckets.items():
            # Sort newest → oldest, then delete everything past the keep limit.
            candidates.sort(reverse=True)
            for mtime, fpath, fname in candidates[PRUNE_KEEP_LATEST:]:
                try:
                    os.remove(fpath)
                    total_deleted += 1
                    print(f"[Backup] 🗑️  Pruned old backup: {dest['name']} / {fname}")
                except Exception as e:
                    print(f"[Backup] ⚠️  Could not prune {fpath}: {e}")

    return total_deleted


# ─────────────────────────────────────────────────────────────────────────────
# ❺  DATABASE BACKUP  (mysqldump → .sql.gz)
# ─────────────────────────────────────────────────────────────────────────────

def _backup_database(run_id: str, triggered_by: str) -> dict:
    """Dump MySQL database to the configured primary dir, then copy to all destinations."""
    primary_dir = _get_primary_dir()
    _ensure_dir(primary_dir)

    ts           = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename     = f"hcp_db_{triggered_by}_{ts}.sql.gz"
    primary_path = os.path.join(primary_dir, filename)

    # ── Locate mysqldump ─────────────────────────────────────────────────────
    try:
        mysqldump_exe = _find_mysql_bin("mysqldump")
    except FileNotFoundError as e:
        msg = str(e)
        _log(run_id, "db", triggered_by, filename, "Primary (local)", 0, "error", msg)
        return {"status": "error", "step": "db_dump", "message": msg}

    dump_cmd = [
        mysqldump_exe,
        f"--host={DB_HOST}",
        f"--port={DB_PORT}",
        f"--user={DB_USER}",
        f"--password={DB_PASSWORD}",
        "--single-transaction",
        "--routines",
        "--triggers",
        "--add-drop-table",
        DB_NAME,
    ]

    # ── Run mysqldump ────────────────────────────────────────────────────────
    try:
        result = subprocess.run(dump_cmd, capture_output=True, check=True, timeout=600)  # 10-min hard limit
        with gzip.open(primary_path, "wb") as gz:
            gz.write(result.stdout)
        size_kb = round(os.path.getsize(primary_path) / 1024, 1)
        _log(run_id, "db", triggered_by, filename, "Primary (local)", size_kb, "ok")
        print(f"[Backup] ✅ DB dump → {filename}  ({size_kb} KB)")
    except subprocess.TimeoutExpired:
        msg = "mysqldump timed out after 10 minutes"
        _log(run_id, "db", triggered_by, filename, "Primary (local)", 0, "error", msg)
        return {"status": "error", "step": "db_dump", "message": msg}
    except subprocess.CalledProcessError as e:
        err = e.stderr.decode(errors="replace").strip()
        _log(run_id, "db", triggered_by, filename, "Primary (local)", 0, "error", err[:500])
        return {"status": "error", "step": "db_dump", "message": err[:300]}
    except Exception as e:
        _log(run_id, "db", triggered_by, filename, "Primary (local)", 0, "error", str(e))
        return {"status": "error", "step": "db_dump", "message": str(e)}

    # ── Step 2: Copy to extra destinations (with per-copy timeout) ─────────
    import threading as _thr
    _DB_COPY_TIMEOUT = 10 * 60   # 10 min — DB dump is small; if it takes longer the network is dead
    copy_results = []
    for dest in _get_extra_destinations():
        dpath = dest["path"]
        if not _ensure_dir(dpath):
            _log(run_id, "copy", triggered_by, filename, dest["name"], 0, "error", "Cannot create/access directory")
            copy_results.append({"dest": dest["name"], "status": "error", "message": "Directory not accessible"})
            continue
        dest_file  = os.path.join(dpath, filename)
        copy_error = [None]
        copy_done  = [False]

        def _do_db_copy(src=primary_path, dst=dest_file, err_ref=copy_error, done_ref=copy_done):
            try:
                shutil.copy2(src, dst)
            except Exception as e:
                err_ref[0] = e
            finally:
                done_ref[0] = True

        ct = _thr.Thread(target=_do_db_copy, daemon=True)
        ct.start()
        ct.join(timeout=_DB_COPY_TIMEOUT)

        if not copy_done[0]:
            msg = f"DB copy to {dest['name']} timed out after {_DB_COPY_TIMEOUT // 60} min"
            print(f"[Backup] ⚠️  {msg}")
            _log(run_id, "copy", triggered_by, filename, dest["name"], 0, "error", msg)
            copy_results.append({"dest": dest["name"], "status": "error", "message": msg})
        elif copy_error[0] is not None:
            err = str(copy_error[0])
            _log(run_id, "copy", triggered_by, filename, dest["name"], 0, "error", err)
            copy_results.append({"dest": dest["name"], "status": "error", "message": err})
            print(f"[Backup] ⚠️  DB copy → {dest['name']} FAILED: {err}")
        else:
            sz = round(os.path.getsize(dest_file) / 1024, 1)
            _log(run_id, "copy", triggered_by, filename, dest["name"], sz, "ok")
            copy_results.append({"dest": dest["name"], "status": "ok", "size_kb": sz})
            print(f"[Backup] 📋 DB copy → {dest['name']} ✅")

    return {
        "status":   "ok",
        "filename": filename,
        "size_kb":  size_kb,
        "path":     primary_path,
        "copies":   copy_results,
    }


# ─────────────────────────────────────────────────────────────────────────────
# ❻  APP FOLDER BACKUP  (app root → .zip)
# ─────────────────────────────────────────────────────────────────────────────

# ZIP timeout: 45 minutes absolute max. 1.5 GB compresses in ~3-8 min normally.
_ZIP_TIMEOUT_SEC = 45 * 60

def _backup_app_folder(run_id: str, triggered_by: str) -> dict:
    """ZIP the entire app folder, save to primary dir, copy to all destinations."""
    import threading, time
    primary_dir = _get_primary_dir()
    extras      = _get_extra_destinations()
    _ensure_dir(primary_dir)

    if not os.path.isdir(SOURCE_APP_FOLDER):
        msg = f"Source folder not found: {SOURCE_APP_FOLDER}"
        _log(run_id, "appzip", triggered_by, "", "Primary (local)", 0, "error", msg)
        return {"status": "error", "step": "source_check", "message": msg}

    ts           = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename     = f"hcp_appfiles_{triggered_by}_{ts}.zip"
    primary_path = os.path.join(primary_dir, filename)

    # ── Build the exclusion set: never ZIP backup destination folders ────────
    # This prevents the classic infinite-loop where the ZIP contains itself.
    # Use realpath so symlinks resolve to their true target before comparison
    # (correct on Linux; normcase was a Windows-only no-op here).
    exclude_paths = set()
    exclude_paths.add(os.path.realpath(primary_dir))
    for dest in extras:
        exclude_paths.add(os.path.realpath(dest["path"]))
    # Also exclude common large/useless folders
    EXCLUDE_DIRNAMES = {"__pycache__", ".git", "backups", "node_modules",
                        ".venv", "venv", ".env", "env", ".mypy_cache",
                        "dist", "build", ".pytest_cache"}

    print(f"[Backup] 📦 Starting App ZIP  (source: {SOURCE_APP_FOLDER})")
    print(f"[Backup] 🚫 Excluded backup dirs: {sorted(exclude_paths)}")

    # ── Count files first so we can report progress ──────────────────────────
    total_files   = 0
    skipped_files = 0

    # ── Step 1: Create ZIP with timeout watchdog ─────────────────────────────
    zip_error     = [None]   # shared via list so inner thread can write it
    zip_done      = [False]
    files_zipped  = [0]

    def _do_zip():
        nonlocal total_files, skipped_files
        try:
            with zipfile.ZipFile(primary_path, "w", zipfile.ZIP_DEFLATED, compresslevel=1) as zf:
                # compresslevel=1 = fastest compression; still ~40% size reduction
                # vs compresslevel=6 which is 3-5x slower for large folders
                for root, dirs, files in os.walk(SOURCE_APP_FOLDER):
                    abs_root = os.path.realpath(root)

                    # Prune excluded dirs IN-PLACE so os.walk won't descend
                    dirs[:] = [
                        d for d in dirs
                        if d not in EXCLUDE_DIRNAMES
                        and os.path.realpath(os.path.join(root, d)) not in exclude_paths
                    ]

                    for file in files:
                        abs_path = os.path.join(root, file)
                        # Skip the ZIP file we're currently writing (safety)
                        if os.path.realpath(abs_path) == os.path.realpath(primary_path):
                            skipped_files += 1
                            continue
                        # Skip files > 500 MB individually (e.g. accidental huge dumps left in folder)
                        try:
                            if os.path.getsize(abs_path) > 500 * 1024 * 1024:
                                print(f"[Backup] ⏭️  Skipping large file (>500MB): {abs_path}")
                                skipped_files += 1
                                continue
                        except OSError:
                            skipped_files += 1
                            continue
                        arcname = os.path.relpath(abs_path, os.path.dirname(SOURCE_APP_FOLDER))
                        try:
                            zf.write(abs_path, arcname)
                            files_zipped[0] += 1
                            total_files += 1
                            if files_zipped[0] % 500 == 0:
                                print(f"[Backup] 📦 Zipping... {files_zipped[0]} files done")
                        except Exception as fe:
                            print(f"[Backup] ⚠️  Could not zip file {abs_path}: {fe}")
                            skipped_files += 1
        except Exception as e:
            zip_error[0] = e
        finally:
            zip_done[0] = True

    zip_thread = threading.Thread(target=_do_zip, daemon=True, name="hcp-zip-worker")
    zip_thread.start()

    # Watchdog: join with timeout
    zip_thread.join(timeout=_ZIP_TIMEOUT_SEC)

    if not zip_done[0]:
        # Thread is still running after timeout — ZIP is hung
        msg = f"App ZIP timed out after {_ZIP_TIMEOUT_SEC // 60} minutes. Possible cause: network path in source tree, or file lock. Backup cancelled."
        print(f"[Backup] ❌ {msg}")
        _log(run_id, "appzip", triggered_by, filename, "Primary (local)", 0, "error", msg)
        # Delete the partial ZIP
        try:
            os.remove(primary_path)
        except Exception:
            pass
        return {"status": "error", "step": "zip_timeout", "message": msg}

    if zip_error[0] is not None:
        err = str(zip_error[0])
        _log(run_id, "appzip", triggered_by, filename, "Primary (local)", 0, "error", err)
        return {"status": "error", "step": "zip_create", "message": err}

    size_kb = round(os.path.getsize(primary_path) / 1024, 1)
    _log(run_id, "appzip", triggered_by, filename, "Primary (local)", size_kb, "ok")
    print(f"[Backup] ✅ App ZIP → {filename}  ({size_kb} KB)  files={files_zipped[0]}  skipped={skipped_files}")

    # ── Step 2: Copy to extra destinations (with per-copy timeout) ───────────
    # Network copy timeout: 30 minutes per file (1.5 GB over LAN = ~2-5 min normally)
    _COPY_TIMEOUT_SEC = 30 * 60

    copy_results = []
    for dest in extras:
        dpath = dest["path"]
        if not _ensure_dir(dpath):
            _log(run_id, "copy", triggered_by, filename, dest["name"], 0, "error", "Cannot create/access directory")
            copy_results.append({"dest": dest["name"], "status": "error", "message": "Directory not accessible"})
            continue
        dest_file  = os.path.join(dpath, filename)
        copy_error = [None]
        copy_done  = [False]

        def _do_copy(src=primary_path, dst=dest_file, err_ref=copy_error, done_ref=copy_done):
            try:
                shutil.copy2(src, dst)
            except Exception as e:
                err_ref[0] = e
            finally:
                done_ref[0] = True

        copy_thread = threading.Thread(target=_do_copy, daemon=True, name=f"hcp-copy-{dest['name']}")
        copy_thread.start()
        copy_thread.join(timeout=_COPY_TIMEOUT_SEC)

        if not copy_done[0]:
            msg = f"Copy to {dest['name']} timed out after {_COPY_TIMEOUT_SEC // 60} min — network may be slow or unreachable."
            print(f"[Backup] ⚠️  {msg}")
            _log(run_id, "copy", triggered_by, filename, dest["name"], 0, "error", msg)
            copy_results.append({"dest": dest["name"], "status": "error", "message": msg})
        elif copy_error[0] is not None:
            err = str(copy_error[0])
            _log(run_id, "copy", triggered_by, filename, dest["name"], 0, "error", err)
            copy_results.append({"dest": dest["name"], "status": "error", "message": err})
            print(f"[Backup] ⚠️  App ZIP copy → {dest['name']} FAILED: {err}")
        else:
            sz = round(os.path.getsize(dest_file) / 1024, 1)
            _log(run_id, "copy", triggered_by, filename, dest["name"], sz, "ok")
            copy_results.append({"dest": dest["name"], "status": "ok", "size_kb": sz})
            print(f"[Backup] 📋 App ZIP copy → {dest['name']} ✅")

    return {
        "status":   "ok",
        "filename": filename,
        "size_kb":  size_kb,
        "path":     primary_path,
        "copies":   copy_results,
    }


# ─────────────────────────────────────────────────────────────────────────────
# ❼  FULL BACKUP RUN  (DB + App ZIP + Prune)  ← called by scheduler & API
# ─────────────────────────────────────────────────────────────────────────────

def run_full_backup(triggered_by: str = "auto") -> dict:
    """
    Master backup routine:
      1. mysqldump → .sql.gz  → copy to all configured destinations
      2. App folder → .zip    → copy to all configured destinations
      3. Prune backups older than 3 days from all locations
    Returns a summary dict.

    All backup paths are read live from the `backup_config` DB table.
    If the admin hasn't configured at least the primary path, this function
    fails fast with a clear error.
    """
    run_id  = datetime.now().strftime("%Y%m%d_%H%M%S")
    started = datetime.now()
    print(f"\n[Backup] ══════ FULL BACKUP START  run_id={run_id}  by={triggered_by} ══════")

    # ── Preflight: verify backup paths are configured ──────────────────────
    try:
        cfg = _load_paths()
    except Exception as e:
        msg = f"Backup aborted — paths not configured: {e}"
        print(f"[Backup] ❌ {msg}")
        try:
            _log(run_id, "preflight", triggered_by, "", "—", 0, "error", str(e)[:500])
        except Exception:
            pass
        return {
            "status":       "error",
            "run_id":       run_id,
            "triggered_by": triggered_by,
            "elapsed_sec":  round((datetime.now() - started).total_seconds(), 1),
            "message":      msg,
        }

    # Report which destinations will be written to (helps debugging)
    dest_summary = ["Primary: " + cfg["primary_path"]]
    if cfg.get("drive_d_path"):
        dest_summary.append("Secondary: " + cfg["drive_d_path"])
    if cfg.get("network_path"):
        dest_summary.append("Network: " + cfg["network_path"])
    print(f"[Backup] 📍 Destinations ({len(dest_summary)}): " + " | ".join(dest_summary))

    db_result  = _backup_database(run_id, triggered_by)
    zip_result = _backup_app_folder(run_id, triggered_by)
    pruned     = prune_old_backups()

    elapsed = round((datetime.now() - started).total_seconds(), 1)

    overall = "ok" if (db_result["status"] == "ok" and zip_result["status"] == "ok") else "partial"

    summary = {
        "status":       overall,
        "run_id":       run_id,
        "triggered_by": triggered_by,
        "elapsed_sec":  elapsed,
        "pruned_files": pruned,
        "db_backup":    db_result,
        "app_backup":   zip_result,
    }
    print(f"[Backup] ══════ FULL BACKUP {'✅ OK' if overall == 'ok' else '⚠️ PARTIAL'}  elapsed={elapsed}s  pruned={pruned} ══════\n")
    return summary


# ─────────────────────────────────────────────────────────────────────────────
# ❽  QUERY HELPERS  (used by API routes) — see also ❾ below for restore
# ─────────────────────────────────────────────────────────────────────────────


def get_backup_stats() -> dict:
    """Return counts and sizes for the dashboard summary cards."""
    try:
        _ensure_log_table()
        conn = _get_conn()
        with conn.cursor() as cur:
            cur.execute("""
                SELECT
                    COUNT(DISTINCT run_id)                                  AS total_runs,
                    SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END)           AS success_count,
                    SUM(CASE WHEN status='error' THEN 1 ELSE 0 END)        AS error_count,
                    MAX(CASE WHEN triggered_by='manual' THEN created_at END) AS last_manual,
                    MAX(CASE WHEN triggered_by='auto'   THEN created_at END) AS last_auto,
                    MAX(created_at)                                          AS last_run
                FROM backup_log
            """)
            stats = dict(cur.fetchone() or {})
        conn.close()
        for k in ("last_manual", "last_auto", "last_run"):
            v = stats.get(k)
            if v and hasattr(v, "strftime"):
                stats[k] = v.strftime("%d/%m/%Y %H:%M")
            elif v is None:
                stats[k] = "—"
        return stats
    except Exception as e:
        return {"error": str(e)}


def list_backup_files() -> list[dict]:
    """
    List all backup files across all destinations with metadata.
    Returns list sorted newest → oldest, dates in DD/MM/YYYY HH:MM format.
    Returns an empty list if backup paths haven't been configured yet.
    """
    seen = set()
    files = []
    try:
        all_dests = _all_destinations()
    except Exception:
        # Paths not configured — return empty list so dashboard renders cleanly.
        return []

    for dest in all_dests:
        dpath = dest["path"]
        if not dpath or not os.path.isdir(dpath):
            continue
        for fname in os.listdir(dpath):
            if not (fname.endswith(".sql.gz") or fname.endswith(".zip")):
                continue
            fpath = os.path.join(dpath, fname)
            try:
                mtime   = datetime.fromtimestamp(os.path.getmtime(fpath))
                size_kb = round(os.path.getsize(fpath) / 1024, 1)
                if fname not in seen:
                    seen.add(fname)
                files.append({
                    "filename":    fname,
                    "destination": dest["name"],
                    "size_kb":     size_kb,
                    "modified":    mtime.strftime("%d/%m/%Y %H:%M"),
                    "modified_raw": mtime.strftime("%Y-%m-%d %H:%M:%S"),
                    "type":        "db"  if fname.endswith(".sql.gz") else "app",
                    "path":        fpath,
                    "restorable":  fname.endswith(".sql.gz"),  # only DB dumps can be restored
                })
            except Exception:
                pass

    files.sort(key=lambda x: x["modified_raw"], reverse=True)
    return files


# ─────────────────────────────────────────────────────────────────────────────
# ❾  RESTORE SYSTEM  –  restore a .sql.gz DB backup into MySQL
# ─────────────────────────────────────────────────────────────────────────────

def restore_database(filename: str) -> dict:
    """
    Restore the MySQL database from a .sql.gz backup file.

    Safety rules:
      - Only accepts filenames matching our own naming pattern
      - Looks for the file in the primary dir first, then all destinations
      - Logs restore attempt to backup_log table
      - Returns {status, message, filename, duration_sec}

    ⚠️  THIS DROPS AND RECREATES ALL TABLES in DB_NAME.
        The admin must confirm this in the UI before calling.
    """
    # ── Validate filename ──────────────────────────────────────────
    if not re.match(r'^hcp_db_(auto|manual)_\d{8}_\d{6}\.sql\.gz$', filename):
        return {"status": "error", "message": "Invalid or unsafe filename — only DB dump files (.sql.gz) can be restored."}

    # ── Locate the file ────────────────────────────────────────────
    filepath = None
    for dest in _all_destinations():
        candidate = os.path.join(dest["path"], filename)
        if os.path.isfile(candidate):
            filepath = candidate
            break

    if not filepath:
        return {"status": "error", "message": f"File not found in any backup location: {filename}"}

    started = datetime.now()
    print(f"[Restore] ▶ Starting restore from: {filepath}")

    # ── Step 1: Decompress .sql.gz to a temp file ──────────────────
    import tempfile
    try:
        tmp = tempfile.NamedTemporaryFile(suffix=".sql", delete=False)
        tmp_path = tmp.name
        with gzip.open(filepath, "rb") as gz:
            shutil.copyfileobj(gz, tmp)
        tmp.close()
        print(f"[Restore] ✅ Decompressed to {tmp_path}")
    except Exception as e:
        return {"status": "error", "message": f"Failed to decompress backup: {e}"}

    # ── Step 2: Run mysql to import ────────────────────────────────
    try:
        mysql_exe = _find_mysql_bin("mysql")
    except FileNotFoundError as e:
        try: os.remove(tmp_path)
        except Exception: pass
        _log_restore(filename, "error", str(e))
        return {"status": "error", "message": str(e)}

    restore_cmd = [
        mysql_exe,
        f"--host={DB_HOST}",
        f"--port={DB_PORT}",
        f"--user={DB_USER}",
        f"--password={DB_PASSWORD}",
        DB_NAME,
    ]
    try:
        with open(tmp_path, "rb") as sql_file:
            result = subprocess.run(
                restore_cmd,
                stdin=sql_file,
                capture_output=True,
                timeout=300,   # 5-minute timeout
            )
        if result.returncode != 0:
            err = result.stderr.decode(errors="replace").strip()
            _log_restore(filename, "error", err[:500])
            return {"status": "error", "message": f"mysql import failed: {err[:300]}"}
    except subprocess.TimeoutExpired:
        _log_restore(filename, "error", "Timed out after 5 minutes")
        return {"status": "error", "message": "Restore timed out after 5 minutes."}
    except Exception as e:
        _log_restore(filename, "error", str(e))
        return {"status": "error", "message": str(e)}
    finally:
        # Always clean up temp file
        try:
            os.remove(tmp_path)
        except Exception:
            pass

    duration = round((datetime.now() - started).total_seconds(), 1)
    _log_restore(filename, "ok", f"Restored in {duration}s")
    print(f"[Restore] ✅ Database restored from {filename} in {duration}s")
    return {
        "status":       "ok",
        "filename":     filename,
        "duration_sec": duration,
        "message":      f"Database successfully restored from {filename} in {duration}s",
    }


def _log_restore(filename: str, status: str, message: str = ""):
    """Log restore attempt into backup_log table with backup_type='restore'."""
    try:
        conn = _get_conn()
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO backup_log
                    (run_id, backup_type, triggered_by, filename, destination, size_kb, status, message)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """, (
                datetime.now().strftime("%Y%m%d_%H%M%S"),
                "restore",
                "manual",
                filename,
                "MySQL",
                0,
                status,
                message[:2000],
            ))
        conn.commit()
        conn.close()
    except Exception:
        pass


def get_backup_log(limit: int = 100) -> list[dict]:
    """Return recent backup_log rows, newest first, dates in DD/MM/YYYY format."""
    try:
        _ensure_log_table()
        conn = _get_conn()
        with conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM backup_log ORDER BY created_at DESC LIMIT %s",
                (limit,)
            )
            rows = cur.fetchall()
        conn.close()
        result = []
        for r in rows:
            row = dict(r)
            if hasattr(row.get("created_at"), "strftime"):
                row["created_at"] = row["created_at"].strftime("%d/%m/%Y %H:%M")
            result.append(row)
        return result
    except Exception as e:
        return []
