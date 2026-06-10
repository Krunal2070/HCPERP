# ══════════════════════════════════════════════════════════════════════════════
# BACKUP SYSTEM — paste these into app.py
# ══════════════════════════════════════════════════════════════════════════════
#
# ── STEP 1: Add this import at the TOP of app.py (with other imports) ─────────
#
#   import backup_system
#
# ── STEP 2: Replace the OLD scheduler block in app.py with this ───────────────
#
#   def _auto_backup_job():
#       result = backup_system.run_full_backup(triggered_by="auto")
#       print(f"[AutoBackup] {result.get('status','?').upper()} — run_id={result.get('run_id','')}")
#
#   _scheduler = BackgroundScheduler(daemon=True)
#   _scheduler.add_job(_auto_backup_job, CronTrigger(hour=2, minute=0),
#                      id="hcp_daily_backup", replace_existing=True)
#   _scheduler.add_job(_auto_backup_job, CronTrigger(day_of_week="sun", hour=3, minute=0),
#                      id="hcp_weekly_backup", replace_existing=True)
#   _scheduler.start()
#   atexit.register(lambda: _scheduler.shutdown(wait=False))
#   print("✅ Auto-backup scheduler started (daily 02:00 · weekly Sun 03:00)")
#
# ── STEP 3: Copy backup_system.py next to app.py ──────────────────────────────
# ── STEP 4: Copy backup_dashboard.html into your templates/ folder ────────────
# ── STEP 5: Paste ALL route functions below into app.py ───────────────────────
# ══════════════════════════════════════════════════════════════════════════════


# ── Backup Dashboard page — accessible at /backup OR /backup_dashboard ────────
@app.route('/backup')
@app.route('/backup_dashboard')
@login_required
def backup_page():
    if (session.get('User_Type') or '').lower() != 'admin':
        return _denied('Backup Manager')
    return render_template('backup_dashboard.html')


# ── Manual backup trigger ──────────────────────────────────────────────────────
@app.route('/api/backup/run', methods=['POST'])
@login_required
def api_backup_run():
    if (session.get('User_Type') or '').lower() != 'admin':
        return jsonify({'status': 'error', 'message': 'Admin only'}), 403
    try:
        result = backup_system.run_full_backup(triggered_by="manual")
        return jsonify(result)
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500


# ── Backup activity log ────────────────────────────────────────────────────────
@app.route('/api/backup/log')
@login_required
def api_backup_log():
    if (session.get('User_Type') or '').lower() != 'admin':
        return jsonify({'status': 'error', 'message': 'Admin only'}), 403
    limit = int(request.args.get('limit', 100))
    return jsonify({'status': 'ok', 'logs': backup_system.get_backup_log(limit)})


# ── Summary stats cards ────────────────────────────────────────────────────────
@app.route('/api/backup/stats')
@login_required
def api_backup_stats():
    if (session.get('User_Type') or '').lower() != 'admin':
        return jsonify({'status': 'error', 'message': 'Admin only'}), 403
    return jsonify({'status': 'ok', 'stats': backup_system.get_backup_stats()})


# ── List backup files across all destinations ──────────────────────────────────
@app.route('/api/backup/files')
@login_required
def api_backup_files():
    if (session.get('User_Type') or '').lower() != 'admin':
        return jsonify({'status': 'error', 'message': 'Admin only'}), 403
    return jsonify({'status': 'ok', 'files': backup_system.list_backup_files()})


# ── Download a backup file ─────────────────────────────────────────────────────
@app.route('/api/backup/download/<path:filename>')
@login_required
def api_backup_download(filename):
    if (session.get('User_Type') or '').lower() != 'admin':
        return jsonify({'status': 'error', 'message': 'Admin only'}), 403
    import re
    if not re.match(r'^hcp_(db|appfiles)_(auto|manual)_\d{8}_\d{6}\.(sql\.gz|zip)$', filename):
        return jsonify({'status': 'error', 'message': 'Invalid filename'}), 400
    return send_from_directory(backup_system.PRIMARY_BACKUP_DIR, filename, as_attachment=True)


# ── Manual prune (delete backups older than 3 days right now) ─────────────────
@app.route('/api/backup/prune', methods=['POST'])
@login_required
def api_backup_prune():
    if (session.get('User_Type') or '').lower() != 'admin':
        return jsonify({'status': 'error', 'message': 'Admin only'}), 403
    try:
        deleted = backup_system.prune_old_backups()
        return jsonify({'status': 'ok', 'deleted': deleted})
    except Exception as e:
        return jsonify({'status': 'error', 'message': str(e)}), 500

# ══════════════════════════════════════════════════════════════════════════════
# END BACKUP ROUTES
# ══════════════════════════════════════════════════════════════════════════════
