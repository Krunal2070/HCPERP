# HCP ERP — Hostinger VPS Deployment Guide
**Target:** `hcperp.co.in` → `187.127.173.88` (Ubuntu 24.04, Nginx)

Run all commands in order. Aap SSH se VPS me login karke chala rahe hain (already logged in as root).

---

## 📦 PRE-REQUISITE: Files Upload (already done ✅)
Your code is at `/var/www/erp/`.

Now upload these 4 new files (from this deployment package) to `/var/www/erp/`:
- `requirements.txt`
- `linux_patch.py`
- `hcperp.service`
- `hcperp.co.in.nginx`

Use FileZilla or run `scp` from your laptop:
```
scp requirements.txt linux_patch.py hcperp.service hcperp.co.in.nginx root@187.127.173.88:/var/www/erp/
```

---

## STEP 1 — Apply Linux Patches (xlwings + port)

```bash
cd /var/www/erp
python3 linux_patch.py
```

This makes `xlwings` imports optional (won't crash on Linux) and changes port from `80` → `8000` in `app.py`.

---

## STEP 2 — Install MySQL Server

```bash
sudo apt update
sudo apt install mysql-server -y
sudo systemctl start mysql
sudo systemctl enable mysql
```

### Set MySQL root password to match your code:

```bash
sudo mysql <<EOF
ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'Mahadev@1234';
CREATE DATABASE IF NOT EXISTS hcp_portal CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
FLUSH PRIVILEGES;
EOF
```

### Test connection:
```bash
mysql -u root -p'Mahadev@1234' -e "SHOW DATABASES;"
```

You should see `hcp_portal` in the list. ✅

> 💡 **Database connection string locations** (already correctly set to `localhost` + `Mahadev@1234` + `hcp_portal`):
> - `/var/www/erp/sampling_portal.py` (lines 22-26)
> - `/var/www/erp/cms_portal.py` (lines 35-39)
> - `/var/www/erp/backup_system.py` (lines 110-114)
> - `/var/www/erp/migrate_sqlite_to_mysql.py` (lines 17-21)
>
> If you want to change password, update **all 4 files**.

---

## STEP 3 — Python Virtual Environment & Dependencies

```bash
sudo apt install python3-venv python3-dev build-essential libmysqlclient-dev pkg-config -y

cd /var/www/erp
python3 -m venv venv
source venv/bin/activate

pip install --upgrade pip
pip install -r requirements.txt
```

⏳ This will take 5-10 minutes (lots of packages — pandas, numpy, selenium etc.)

### If any package fails, install it manually:
```bash
pip install <package-name>
```

---

## STEP 4 — Restore Database (if you have a backup)

If you have a `.sql` or `.sql.gz` backup of your existing `hcp_portal` MySQL database, upload it and restore:

```bash
# For .sql file
mysql -u root -p'Mahadev@1234' hcp_portal < /var/www/erp/your_backup.sql

# For .sql.gz file
gunzip -c /var/www/erp/your_backup.sql.gz | mysql -u root -p'Mahadev@1234' hcp_portal
```

If no backup — the app will create empty tables on first run.

---

## STEP 5 — Test App Manually (Before systemd)

```bash
cd /var/www/erp
source venv/bin/activate
python app.py
```

Should see: `🚀 Starting HCP Portal on http://0.0.0.0:8000`

Open new terminal (or another SSH window) and test:
```bash
curl -I http://localhost:8000
```

Should get `HTTP/1.1 200 OK` or similar. ✅

Press `Ctrl+C` to stop the test run, then proceed to step 6.

> ⚠️ If you get import errors, install missing packages with `pip install <name>`.

---

## STEP 6 — Install systemd Service (Auto-start on boot)

```bash
sudo cp /var/www/erp/hcperp.service /etc/systemd/system/hcperp.service
sudo systemctl daemon-reload
sudo systemctl enable hcperp
sudo systemctl start hcperp
```

### Check status:
```bash
sudo systemctl status hcperp
```

Should be `active (running)` in green. ✅

### View logs (if errors):
```bash
sudo tail -f /var/log/hcperp.log
sudo tail -f /var/log/hcperp-error.log
```

### Useful service commands:
```bash
sudo systemctl restart hcperp    # restart after code change
sudo systemctl stop hcperp
sudo systemctl status hcperp
```

---

## STEP 7 — Configure Nginx Reverse Proxy

```bash
# Remove default nginx site
sudo rm -f /etc/nginx/sites-enabled/default

# Copy your site config
sudo cp /var/www/erp/hcperp.co.in.nginx /etc/nginx/sites-available/hcperp.co.in

# Enable the site
sudo ln -sf /etc/nginx/sites-available/hcperp.co.in /etc/nginx/sites-enabled/

# Test config
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

### Test directly via IP:
```bash
curl -I http://187.127.173.88
```

Should reach your app (not the default Nginx welcome page). ✅

---

## STEP 8 — Point Domain to VPS

Go to your domain registrar's DNS panel (where you renewed `hcperp.co.in`) and add:

| Type | Name/Host | Value | TTL |
|------|-----------|-------|-----|
| A | @ | 187.127.173.88 | 3600 |
| A | www | 187.127.173.88 | 3600 |

Wait 15 min – 2 hours for DNS propagation. Check at: https://dnschecker.org/#A/hcperp.co.in

Once propagated, open browser: `http://hcperp.co.in` — your ERP should load! 🎉

---

## STEP 9 — Install Free SSL (https)

Once domain points to VPS:

```bash
sudo apt install certbot python3-certbot-nginx -y
sudo certbot --nginx -d hcperp.co.in -d www.hcperp.co.in
```

Follow the prompts:
- Enter your email
- Agree to terms
- Choose `2` (redirect HTTP → HTTPS) when asked

Auto-renewal is set up automatically. Test it:
```bash
sudo certbot renew --dry-run
```

Now `https://hcperp.co.in` works with a green padlock. 🔒

---

## STEP 10 — (Optional but Recommended) Office-Only Access

Since this is internal ERP, you can restrict access to your office IP at Nginx level:

1. Get your office's public IP: https://whatismyipaddress.com (from office computer)
2. Edit Nginx config:
   ```bash
   sudo nano /etc/nginx/sites-available/hcperp.co.in
   ```
3. Uncomment the `allow`/`deny` block and put your office IP
4. Reload Nginx:
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

Now only office network can open the site. App login adds the second layer.

> ⚠️ If office IP is dynamic (changes daily), skip this — rely only on app login.

---

## 🔥 Firewall (UFW) — Allow only what's needed

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
sudo ufw status
```

---

## 🆘 Troubleshooting

### App not starting?
```bash
sudo journalctl -u hcperp -n 50 --no-pager
sudo tail -50 /var/log/hcperp-error.log
```

### Module import errors?
```bash
cd /var/www/erp
source venv/bin/activate
pip install <missing-module>
sudo systemctl restart hcperp
```

### 502 Bad Gateway from Nginx?
The Python app is down. Check:
```bash
sudo systemctl status hcperp
curl http://127.0.0.1:8000
```

### MySQL connection error?
```bash
mysql -u root -p'Mahadev@1234' hcp_portal -e "SHOW TABLES;"
```

---

## 📋 Summary of What Won't Work (Windows-only features)

These will throw errors when called but rest of ERP works fine:
- **Petty Cash Excel** routes (`xlwings` needed) — was reading `\\Hcp-server\d\...\PETTY CASH FROM 25-26 new.xlsx`
- **Tally integration** — needs LAN access to `192.168.2.91:9000`
- **Excel PDF export** in Production Initiater — uses xlwings

To enable any of these later, you'd need:
- A site-to-site VPN from VPS to office network, OR
- Replace `xlwings` with `openpyxl` (Linux-compatible) for read-only operations, OR
- Move those specific files to office network share via SFTP sync

---

## ✅ Final Check

When everything's done:
- [ ] `https://hcperp.co.in` opens with green padlock
- [ ] `sudo systemctl status hcperp` shows `active (running)`
- [ ] `sudo systemctl status nginx` shows `active (running)`
- [ ] `sudo systemctl status mysql` shows `active (running)`
- [ ] App login works
- [ ] After server reboot, all services auto-start

Done! 🎉
