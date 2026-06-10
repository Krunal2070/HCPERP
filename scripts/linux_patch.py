#!/usr/bin/env python3
"""
HCP ERP — Linux Deployment Patch Script
========================================
Makes Windows-specific code (xlwings) optional so app runs on Linux.
Changes server port from 80 → 8000 (Nginx will reverse-proxy from 80/443).

Run from /var/www/erp directory:
    cd /var/www/erp
    python3 linux_patch.py

Safe to run multiple times — idempotent (only patches if not already patched).
"""
import os
import re
import sys
from pathlib import Path

# Files that import xlwings at top level
XLWINGS_FILES = [
    "app.py",
    "cash_routes.py",
    "production_initiater_routes.py",
    "rm_store/production_initiater_routes.py",
]

# Marker so we don't re-patch
MARKER = "# LINUX_PATCH_APPLIED"


def patch_xlwings_import(path: Path) -> bool:
    """Wrap `import xlwings as xw` in try/except so app works without it."""
    if not path.exists():
        print(f"  [skip] {path} — file not found")
        return False

    text = path.read_text(encoding="utf-8", errors="ignore")

    if MARKER in text:
        print(f"  [skip] {path} — already patched")
        return False

    new_text = re.sub(
        r"^import xlwings as xw\s*$",
        (
            f"{MARKER}\n"
            "try:\n"
            "    import xlwings as xw  # Windows-only; safe to skip on Linux\n"
            "except ImportError:\n"
            "    xw = None  # Excel/petty-cash routes will return error if called"
        ),
        text,
        count=1,
        flags=re.MULTILINE,
    )

    if new_text == text:
        print(f"  [skip] {path} — no `import xlwings as xw` at top level")
        return False

    path.write_text(new_text, encoding="utf-8")
    print(f"  [ok]   {path} — xlwings now optional")
    return True


def patch_app_port(app_py: Path) -> bool:
    """Change `port=80` → `port=8000` in app.py so Nginx can own 80/443."""
    if not app_py.exists():
        print(f"  [skip] {app_py} — file not found")
        return False

    text = app_py.read_text(encoding="utf-8", errors="ignore")

    if "port=8000" in text and "port=80," not in text:
        print(f"  [skip] {app_py} — already on port 8000")
        return False

    new_text = re.sub(r"port\s*=\s*80\s*,", "port=8000,", text, count=1)
    new_text = new_text.replace(
        "http://0.0.0.0:80", "http://0.0.0.0:8000"
    )

    if new_text == text:
        print(f"  [warn] {app_py} — couldn't find port=80 to replace")
        return False

    app_py.write_text(new_text, encoding="utf-8")
    print(f"  [ok]   {app_py} — port changed to 8000")
    return True


def main():
    base = Path.cwd()
    print(f"Patching ERP for Linux in: {base}\n")

    print("Step 1: Make xlwings imports optional")
    for rel in XLWINGS_FILES:
        patch_xlwings_import(base / rel)

    print("\nStep 2: Change app.py port 80 → 8000")
    patch_app_port(base / "app.py")

    print("\nDone. App is ready for Linux deployment.")
    print("Note: Petty Cash & Excel-export routes will return errors if called —")
    print("      add `xlwings` removal logic later if those features are needed.")


if __name__ == "__main__":
    main()
