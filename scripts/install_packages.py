"""
HCP Portal - Python Packages Installer
=======================================
Double-click this file to install all required packages at once.
Make sure Python is installed and added to PATH before running.
"""

import subprocess
import sys
import os
import time

# All packages with exact versions from your environment
PACKAGES = [
    "alembic==1.18.4",
    "annotated-types==0.7.0",
    "anthropic==0.96.0",
    "anyio==4.13.0",
    "APScheduler==3.11.2",
    "attrs==25.4.0",
    "blinker==1.9.0",
    "certifi==2026.1.4",
    "cffi==2.0.0",
    "charset-normalizer==3.4.4",
    "click==8.3.1",
    "colorama==0.4.6",
    "cryptography==46.0.5",
    "distro==1.9.0",
    "dnspython==2.8.0",
    "docstring_parser==0.18.0",
    "email-validator==2.3.0",
    "et_xmlfile==2.0.0",
    "Flask==3.1.2",
    "flask-cors==6.0.2",
    "Flask-Login==0.6.3",
    "Flask-Migrate==4.1.0",
    "Flask-SQLAlchemy==3.1.1",
    "Flask-WTF==1.2.2",
    "google-api-core==2.30.3",
    "google-api-python-client==2.194.0",
    "google-auth==2.49.2",
    "google-auth-httplib2==0.3.1",
    "google-auth-oauthlib==1.3.1",
    "googleapis-common-protos==1.74.0",
    "greenlet==3.4.0",
    "h11==0.16.0",
    "httpcore==1.0.9",
    "httplib2==0.31.2",
    "httpx==0.28.1",
    "idna==3.11",
    "itsdangerous==2.2.0",
    "Jinja2==3.1.6",
    "jiter==0.14.0",
    "Mako==1.3.10",
    "MarkupSafe==3.0.3",
    "mysql-connector-python==9.6.0",
    "numpy==2.4.2",
    "oauthlib==3.3.1",
    "openpyxl==3.1.5",
    "outcome==1.3.0.post0",
    "packaging==26.0",
    "pandas==3.0.0",
    "pillow==12.1.1",
    "proto-plus==1.27.2",
    "protobuf==7.34.1",
    "pyasn1==0.6.3",
    "pyasn1_modules==0.4.2",
    "pycparser==3.0",
    "pydantic==2.13.1",
    "pydantic_core==2.46.1",
    "PyMySQL==1.1.2",
    "pyparsing==3.3.2",
    "PySocks==1.7.1",
    "python-dateutil==2.9.0.post0",
    "python-dotenv==1.2.1",
    "pytimeparse2==1.7.1",
    "pywin32==311",
    "reportlab==4.4.10",
    "requests==2.32.5",
    "requests-oauthlib==2.0.0",
    "selenium==4.41.0",
    "simplejson==3.20.2",
    "six==1.17.0",
    "sniffio==1.3.1",
    "sortedcontainers==2.4.0",
    "SQLAlchemy==2.0.49",
    "sqlglot==29.0.1",
    "sqlite3-to-mysql==2.5.5",
    "tabulate==0.10.0",
    "tqdm==4.67.3",
    "trio==0.33.0",
    "trio-websocket==0.12.2",
    "typing_extensions==4.15.0",
    "typing-inspection==0.4.2",
    "tzdata==2025.3",
    "tzlocal==5.3.1",
    "Unidecode==1.4.0",
    "uritemplate==4.2.0",
    "urllib3==2.6.3",
    "waitress==3.0.2",
    "webdriver-manager==4.0.2",
    "websocket-client==1.9.0",
    "Werkzeug==3.1.5",
    "wsproto==1.3.2",
    "WTForms==3.2.1",
    "xlwings==0.33.20",
    "xmltodict==1.0.2",
]


def print_banner():
    print("=" * 70)
    print("           HCP Portal - Python Packages Installer")
    print("=" * 70)
    print(f"Python version : {sys.version.split()[0]}")
    print(f"Python path    : {sys.executable}")
    print(f"Total packages : {len(PACKAGES)}")
    print("=" * 70)
    print()


def upgrade_pip():
    print(">>> Upgrading pip to latest version...")
    try:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "--upgrade", "pip"]
        )
        print(">>> pip upgraded successfully.\n")
    except subprocess.CalledProcessError:
        print(">>> pip upgrade failed, continuing anyway...\n")


def install_all_at_once():
    """Try to install everything in a single pip command (fastest)."""
    print(">>> Attempting batch install of all packages...\n")
    try:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "--upgrade"] + PACKAGES
        )
        return True
    except subprocess.CalledProcessError:
        return False


def install_one_by_one():
    """Fallback: install each package individually, logging failures."""
    print("\n>>> Batch install failed. Installing packages one by one...\n")
    failed = []
    for i, pkg in enumerate(PACKAGES, 1):
        print(f"[{i}/{len(PACKAGES)}] Installing {pkg} ...")
        try:
            subprocess.check_call(
                [sys.executable, "-m", "pip", "install", "--upgrade", pkg]
            )
        except subprocess.CalledProcessError:
            print(f"    !! FAILED: {pkg}")
            failed.append(pkg)
        print()
    return failed


def main():
    print_banner()
    upgrade_pip()

    start = time.time()
    batch_ok = install_all_at_once()

    failed = []
    if not batch_ok:
        failed = install_one_by_one()

    elapsed = time.time() - start
    print("\n" + "=" * 70)
    if batch_ok:
        print(" [OK] All packages installed successfully!")
    elif not failed:
        print(" [OK] All packages installed successfully (one-by-one mode)!")
    else:
        print(f" [WARN] {len(failed)} package(s) failed to install:")
        for p in failed:
            print(f"    - {p}")
        print("\n Try running manually: pip install <package_name>")
    print(f" Total time: {elapsed:.1f} seconds")
    print("=" * 70)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n>>> Installation cancelled by user.")
    except Exception as e:
        print(f"\n\n!! Unexpected error: {e}")
    finally:
        # Keep the window open so you can read the output after double-clicking
        if os.name == "nt":
            input("\nPress ENTER to close this window...")
