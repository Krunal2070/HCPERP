"""
cctv_routes.py — HCP CCTV Module
================================
Flask Blueprint providing:
  • Recorders CRUD (DVR / NVR with credentials)
  • Cameras (auto-generated per channel; user edits name/location/flags)
  • Groups CRUD (user-owned + shared)
  • Live wall (paginated 3×3 grid with group selector)
  • Playback (Hikvision time-range RTSP)

Architecture:
  • All RTSP traffic goes through go2rtc on the worker PC (port 1984).
    Browsers play WebRTC; Python AI worker pulls MJPEG snapshots.
  • Passwords stored XOR-obfuscated using the same _obfuscate helpers
    that app.py already uses for tally_credentials. No new crypto dep.

Register in app.py:
    from cctv_routes import cctv_bp, ensure_cctv_tables
    ensure_cctv_tables()
    app.register_blueprint(cctv_bp)
"""

from flask import Blueprint, render_template, request, jsonify, session, redirect, url_for, Response, send_file
from functools import wraps
import io
import json
import sampling_portal
import cctv_go2rtc_manager as g2m
from portal_helpers import can_access, _denied

cctv_bp = Blueprint('cctv', __name__)

# ── Password obfuscation (matches app.py _obfuscate / _deobfuscate exactly) ──
import base64
_CCTV_KEY = b'hcp_cctv_cred_key_2026'

def _obfuscate(text: str) -> str:
    if not text:
        return ''
    key = _CCTV_KEY
    data = text.encode('utf-8')
    xored = bytes(b ^ key[i % len(key)] for i, b in enumerate(data))
    return base64.b64encode(xored).decode('ascii')

def _deobfuscate(token: str) -> str:
    if not token:
        return ''
    try:
        key = _CCTV_KEY
        raw = base64.b64decode(token.encode('ascii'))
        plain = bytes(b ^ key[i % len(key)] for i, b in enumerate(raw))
        return plain.decode('utf-8', errors='ignore')
    except Exception:
        return ''


# ─────────────────────────────────────────────────────────────────────────────
# Schema bootstrap
# ─────────────────────────────────────────────────────────────────────────────
def ensure_cctv_tables():
    """Create cctv_* tables on first run. Idempotent."""
    conn = sampling_portal.get_db_connection()
    if not conn:
        return
    try:
        # Statements split because some MySQL drivers don't support multi-statement.
        stmts = [
            """CREATE TABLE IF NOT EXISTS cctv_recorders (
                id INT AUTO_INCREMENT PRIMARY KEY,
                name VARCHAR(120) NOT NULL,
                kind ENUM('DVR','NVR') NOT NULL,
                ip VARCHAR(45) NOT NULL,
                rtsp_port INT NOT NULL DEFAULT 554,
                http_port INT NOT NULL DEFAULT 80,
                username VARCHAR(120) NOT NULL,
                password_enc VARCHAR(500) NOT NULL DEFAULT '',
                encryption_key_enc VARCHAR(500) NOT NULL DEFAULT '',
                channel_count INT NOT NULL DEFAULT 16,
                rtsp_template VARCHAR(40) NOT NULL DEFAULT 'modern',
                is_active TINYINT(1) NOT NULL DEFAULT 1,
                notes VARCHAR(500) DEFAULT '',
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_recorder_ip (ip, rtsp_port)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",

            """CREATE TABLE IF NOT EXISTS cctv_cameras (
                id INT AUTO_INCREMENT PRIMARY KEY,
                recorder_id INT NOT NULL,
                channel INT NOT NULL,
                name VARCHAR(160) NOT NULL DEFAULT '',
                location VARCHAR(200) DEFAULT '',
                department VARCHAR(60) DEFAULT '',
                ai_enabled TINYINT(1) NOT NULL DEFAULT 0,
                is_active TINYINT(1) NOT NULL DEFAULT 1,
                sort_order INT NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE KEY uniq_recorder_channel (recorder_id, channel),
                KEY idx_active (is_active),
                KEY idx_ai (ai_enabled),
                CONSTRAINT fk_cam_recorder FOREIGN KEY (recorder_id)
                    REFERENCES cctv_recorders(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",

            """CREATE TABLE IF NOT EXISTS cctv_groups (
                id INT AUTO_INCREMENT PRIMARY KEY,
                owner_user_id INT NOT NULL,
                name VARCHAR(120) NOT NULL,
                description VARCHAR(300) DEFAULT '',
                is_shared TINYINT(1) NOT NULL DEFAULT 0,
                sort_order INT NOT NULL DEFAULT 0,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                KEY idx_owner (owner_user_id),
                KEY idx_shared (is_shared)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",

            """CREATE TABLE IF NOT EXISTS cctv_camera_groups (
                group_id INT NOT NULL,
                camera_id INT NOT NULL,
                position INT NOT NULL DEFAULT 0,
                PRIMARY KEY (group_id, camera_id),
                KEY idx_position (group_id, position),
                CONSTRAINT fk_cg_group  FOREIGN KEY (group_id)  REFERENCES cctv_groups(id)  ON DELETE CASCADE,
                CONSTRAINT fk_cg_camera FOREIGN KEY (camera_id) REFERENCES cctv_cameras(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",

            """CREATE TABLE IF NOT EXISTS cctv_zones (
                id INT AUTO_INCREMENT PRIMARY KEY,
                camera_id INT NOT NULL,
                name VARCHAR(120) NOT NULL,
                zone_type ENUM('worker_station','packing_area','aisle','restricted','line') NOT NULL DEFAULT 'worker_station',
                polygon_json TEXT NOT NULL,
                min_persons INT NOT NULL DEFAULT 0,
                max_idle_sec INT NOT NULL DEFAULT 300,
                max_empty_sec INT NOT NULL DEFAULT 600,
                active_from TIME DEFAULT '09:00:00',
                active_to TIME DEFAULT '18:00:00',
                is_active TINYINT(1) NOT NULL DEFAULT 1,
                created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                KEY idx_camera (camera_id),
                CONSTRAINT fk_zone_camera FOREIGN KEY (camera_id) REFERENCES cctv_cameras(id) ON DELETE CASCADE
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",

            """CREATE TABLE IF NOT EXISTS cctv_events (
                id BIGINT AUTO_INCREMENT PRIMARY KEY,
                camera_id INT NOT NULL,
                zone_id INT DEFAULT NULL,
                event_type VARCHAR(40) NOT NULL,
                severity ENUM('info','warning','critical') NOT NULL DEFAULT 'warning',
                started_at DATETIME NOT NULL,
                ended_at DATETIME DEFAULT NULL,
                person_count INT DEFAULT 0,
                snapshot_path VARCHAR(400) DEFAULT '',
                notes VARCHAR(500) DEFAULT '',
                acknowledged TINYINT(1) NOT NULL DEFAULT 0,
                acknowledged_by INT DEFAULT NULL,
                acknowledged_at DATETIME DEFAULT NULL,
                KEY idx_camera_time (camera_id, started_at),
                KEY idx_event_type (event_type),
                KEY idx_open (acknowledged, ended_at),
                CONSTRAINT fk_evt_camera FOREIGN KEY (camera_id) REFERENCES cctv_cameras(id) ON DELETE CASCADE,
                CONSTRAINT fk_evt_zone   FOREIGN KEY (zone_id)   REFERENCES cctv_zones(id)   ON DELETE SET NULL
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4""",
        ]
        for s in stmts:
            conn.execute(s)

        # Idempotent column add — for portals where cctv_recorders was created
        # before encryption_key support was added.
        try:
            cols = conn.execute("SHOW COLUMNS FROM cctv_recorders LIKE 'encryption_key_enc'").fetchall()
            if not cols:
                conn.execute("ALTER TABLE cctv_recorders ADD COLUMN encryption_key_enc VARCHAR(500) NOT NULL DEFAULT '' AFTER password_enc")
                print("✅ cctv_recorders.encryption_key_enc column added")
        except Exception as e:
            print(f"encryption_key_enc migration skipped: {e}")

        conn.commit()
        print("✅ cctv_* tables ensured")
    except Exception as e:
        print(f"ensure_cctv_tables error: {e}")
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# Auth helpers
# ─────────────────────────────────────────────────────────────────────────────
def _login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get('logged_in'):
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    return wrapper

def _is_admin() -> bool:
    return (session.get('User_Type') or '').lower() == 'admin'

def _admin_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get('logged_in'):
            return redirect(url_for('login'))
        if not _is_admin():
            return _denied('CCTV Admin')
        return f(*args, **kwargs)
    return wrapper

def _current_user_id() -> int:
    return int(session.get('user_id') or 0)


# ─────────────────────────────────────────────────────────────────────────────
# RTSP URL builder — Hikvision conventions
# ─────────────────────────────────────────────────────────────────────────────
def build_rtsp_url(recorder: dict, channel: int, stream: str = 'sub', playback=None) -> str:
    """
    Build Hikvision RTSP URL for live or playback.

    Live (modern firmware, NVR + most DVRs):
        rtsp://user:pass@ip:port/Streaming/Channels/{ch}{01|02}
        01 = main stream, 02 = sub stream

    Live (legacy DVR firmware):
        rtsp://user:pass@ip:port/h264/ch{ch}/{main|sub}/av_stream

    Playback (time-range, modern firmware):
        rtsp://user:pass@ip:port/Streaming/tracks/{ch}01?starttime=YYYYMMDDThhmmssZ&endtime=...

    If the recorder has stream encryption enabled, the encryption key is
    appended as ?key=<key> (or &key= if other query params already exist).
    Most Hikvision LAN deployments don't need this — leave the key blank.
    """
    user = recorder['username']
    pw   = _deobfuscate(recorder.get('password_enc', ''))
    enc_key = _deobfuscate(recorder.get('encryption_key_enc', ''))
    ip   = recorder['ip']
    port = recorder.get('rtsp_port', 554)
    tmpl = (recorder.get('rtsp_template') or 'modern').lower()
    auth = f"{user}:{pw}@" if user else ""

    if playback:
        start = playback.get('start')  # 'YYYYMMDDThhmmssZ'
        end   = playback.get('end')
        url = f"rtsp://{auth}{ip}:{port}/Streaming/tracks/{channel:02d}01?starttime={start}&endtime={end}"
        if enc_key:
            url += f"&key={enc_key}"
        return url

    if tmpl == 'legacy':
        s = 'main' if stream == 'main' else 'sub'
        url = f"rtsp://{auth}{ip}:{port}/h264/ch{channel}/{s}/av_stream"
        if enc_key:
            url += f"?key={enc_key}"
        return url

    # modern
    sn = '01' if stream == 'main' else '02'
    url = f"rtsp://{auth}{ip}:{port}/Streaming/Channels/{channel:02d}{sn}"
    if enc_key:
        url += f"?key={enc_key}"
    return url


# ─────────────────────────────────────────────────────────────────────────────
# Pages
# ─────────────────────────────────────────────────────────────────────────────
@cctv_bp.route('/cctv')
@_login_required
def cctv_home():
    """Live wall — main page everyone hits."""
    return render_template('cctv_live_wall.html')


@cctv_bp.route('/cctv/playback')
@_login_required
def cctv_playback():
    return render_template('cctv_playback.html')


@cctv_bp.route('/cctv/groups')
@_login_required
def cctv_groups_page():
    return render_template('cctv_groups.html')


@cctv_bp.route('/cctv/admin')
@_admin_required
def cctv_admin_page():
    """Recorders + cameras admin — admin only."""
    return render_template('cctv_admin.html')


# ─────────────────────────────────────────────────────────────────────────────
# Recorders API (admin only for write)
# ─────────────────────────────────────────────────────────────────────────────
@cctv_bp.route('/api/cctv/recorders', methods=['GET'])
@_login_required
def api_recorders_list():
    conn = sampling_portal.get_db_connection()
    try:
        rows = conn.execute("""
            SELECT id, name, kind, ip, rtsp_port, http_port, username,
                   channel_count, rtsp_template, is_active, notes,
                   (LENGTH(password_enc) > 0)        AS has_password,
                   (LENGTH(encryption_key_enc) > 0)  AS has_encryption_key
            FROM cctv_recorders
            ORDER BY name
        """).fetchall()
        # Never return passwords or encryption keys. Just indicators of whether they're set.
        out = []
        for r in rows:
            d = dict(r)
            d['has_password']       = bool(d.get('has_password'))
            d['has_encryption_key'] = bool(d.get('has_encryption_key'))
            out.append(d)
        return jsonify({'ok': True, 'recorders': out})
    finally:
        conn.close()


@cctv_bp.route('/api/cctv/recorders', methods=['POST'])
@_admin_required
def api_recorders_create():
    """Create recorder + auto-generate channel_count camera rows."""
    data = request.get_json(force=True) or {}
    name  = (data.get('name') or '').strip()
    kind  = (data.get('kind') or 'NVR').upper()
    ip    = (data.get('ip') or '').strip()
    rtsp_port = int(data.get('rtsp_port') or 554)
    http_port = int(data.get('http_port') or 80)
    username  = (data.get('username') or '').strip()
    password  = data.get('password') or ''
    encryption_key = data.get('encryption_key') or ''
    channel_count = int(data.get('channel_count') or 16)
    rtsp_template = (data.get('rtsp_template') or 'modern').lower()
    notes  = (data.get('notes') or '').strip()

    if not (name and ip and username and channel_count > 0):
        return jsonify({'ok': False, 'error': 'name, ip, username, channel_count required'}), 400
    if kind not in ('DVR', 'NVR'):
        return jsonify({'ok': False, 'error': 'kind must be DVR or NVR'}), 400

    conn = sampling_portal.get_db_connection()
    try:
        cur = conn.execute("""
            INSERT INTO cctv_recorders
                (name, kind, ip, rtsp_port, http_port, username, password_enc,
                 encryption_key_enc, channel_count, rtsp_template, notes)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
        """, (name, kind, ip, rtsp_port, http_port, username,
              _obfuscate(password), _obfuscate(encryption_key),
              channel_count, rtsp_template, notes))
        rec_id = cur.lastrowid

        # Auto-generate camera rows for every channel
        for ch in range(1, channel_count + 1):
            conn.execute("""
                INSERT INTO cctv_cameras (recorder_id, channel, name, sort_order)
                VALUES (%s,%s,%s,%s)
            """, (rec_id, ch, f"{name} CH{ch:02d}", ch))

        conn.commit()
        return jsonify({'ok': True, 'id': rec_id})
    except Exception as e:
        conn.rollback()
        return jsonify({'ok': False, 'error': str(e)}), 500
    finally:
        conn.close()


@cctv_bp.route('/api/cctv/recorders/<int:rec_id>', methods=['PUT'])
@_admin_required
def api_recorders_update(rec_id):
    data = request.get_json(force=True) or {}
    conn = sampling_portal.get_db_connection()
    try:
        # Load current to detect channel_count change
        row = conn.execute("SELECT channel_count FROM cctv_recorders WHERE id=%s", (rec_id,)).fetchone()
        if not row:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        old_count = int(row['channel_count'])

        fields = []
        params = []
        for k in ('name','kind','ip','rtsp_port','http_port','username',
                  'channel_count','rtsp_template','notes','is_active'):
            if k in data:
                fields.append(f"{k}=%s")
                params.append(data[k])
        # Password update is optional — only if non-empty string sent
        if data.get('password'):
            fields.append("password_enc=%s")
            params.append(_obfuscate(data['password']))
        # Encryption key update is also optional. Send empty string explicitly to clear it.
        if 'encryption_key' in data:
            fields.append("encryption_key_enc=%s")
            params.append(_obfuscate(data['encryption_key'] or ''))

        if not fields:
            return jsonify({'ok': False, 'error': 'no fields to update'}), 400

        params.append(rec_id)
        conn.execute(f"UPDATE cctv_recorders SET {', '.join(fields)} WHERE id=%s", params)

        # If channel count grew, add the new channels
        new_count = int(data.get('channel_count', old_count))
        if new_count > old_count:
            name_row = conn.execute("SELECT name FROM cctv_recorders WHERE id=%s", (rec_id,)).fetchone()
            base = name_row['name'] if name_row else 'Recorder'
            for ch in range(old_count + 1, new_count + 1):
                conn.execute("""
                    INSERT IGNORE INTO cctv_cameras (recorder_id, channel, name, sort_order)
                    VALUES (%s,%s,%s,%s)
                """, (rec_id, ch, f"{base} CH{ch:02d}", ch))

        conn.commit()
        return jsonify({'ok': True})
    except Exception as e:
        conn.rollback()
        return jsonify({'ok': False, 'error': str(e)}), 500
    finally:
        conn.close()


@cctv_bp.route('/api/cctv/recorders/<int:rec_id>', methods=['DELETE'])
@_admin_required
def api_recorders_delete(rec_id):
    conn = sampling_portal.get_db_connection()
    try:
        conn.execute("DELETE FROM cctv_recorders WHERE id=%s", (rec_id,))
        conn.commit()
        return jsonify({'ok': True})
    finally:
        conn.close()


@cctv_bp.route('/api/cctv/recorders/<int:rec_id>/test', methods=['POST'])
@_admin_required
def api_recorders_test(rec_id):
    """Quick reachability test: TCP connect to recorder's HTTP port."""
    import socket
    conn = sampling_portal.get_db_connection()
    try:
        row = conn.execute("SELECT ip, http_port FROM cctv_recorders WHERE id=%s", (rec_id,)).fetchone()
        if not row:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(3.0)
        try:
            s.connect((row['ip'], int(row['http_port'])))
            return jsonify({'ok': True, 'reachable': True})
        except Exception as e:
            return jsonify({'ok': True, 'reachable': False, 'error': str(e)})
        finally:
            s.close()
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# Cameras API
# ─────────────────────────────────────────────────────────────────────────────
@cctv_bp.route('/api/cctv/cameras', methods=['GET'])
@_login_required
def api_cameras_list():
    """List cameras with recorder info. Optional ?recorder_id=N filter."""
    rec_id = request.args.get('recorder_id', type=int)
    conn = sampling_portal.get_db_connection()
    try:
        sql = """
            SELECT c.id, c.recorder_id, c.channel, c.name, c.location, c.department,
                   c.ai_enabled, c.is_active, c.sort_order,
                   r.name AS recorder_name, r.kind AS recorder_kind, r.ip AS recorder_ip,
                   r.rtsp_template
            FROM cctv_cameras c
            JOIN cctv_recorders r ON r.id = c.recorder_id
        """
        params = []
        if rec_id:
            sql += " WHERE c.recorder_id=%s"
            params.append(rec_id)
        sql += " ORDER BY r.name, c.channel"
        rows = conn.execute(sql, params).fetchall()
        return jsonify({'ok': True, 'cameras': [dict(r) for r in rows]})
    finally:
        conn.close()


@cctv_bp.route('/api/cctv/cameras/<int:cam_id>', methods=['PUT'])
@_admin_required
def api_camera_update(cam_id):
    data = request.get_json(force=True) or {}
    fields, params = [], []
    for k in ('name','location','department','ai_enabled','is_active','sort_order'):
        if k in data:
            fields.append(f"{k}=%s")
            params.append(data[k])
    if not fields:
        return jsonify({'ok': False, 'error': 'no fields'}), 400
    params.append(cam_id)
    conn = sampling_portal.get_db_connection()
    try:
        conn.execute(f"UPDATE cctv_cameras SET {', '.join(fields)} WHERE id=%s", params)
        conn.commit()
        return jsonify({'ok': True})
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# Groups API (any logged-in user can manage their own groups)
# ─────────────────────────────────────────────────────────────────────────────
@cctv_bp.route('/api/cctv/groups', methods=['GET'])
@_login_required
def api_groups_list():
    """Return groups visible to current user: own + shared."""
    uid = _current_user_id()
    conn = sampling_portal.get_db_connection()
    try:
        rows = conn.execute("""
            SELECT g.id, g.name, g.description, g.is_shared, g.owner_user_id, g.sort_order,
                   (SELECT COUNT(*) FROM cctv_camera_groups cg WHERE cg.group_id=g.id) AS cam_count
            FROM cctv_groups g
            WHERE g.owner_user_id=%s OR g.is_shared=1
            ORDER BY g.is_shared DESC, g.sort_order, g.name
        """, (uid,)).fetchall()
        return jsonify({'ok': True, 'groups': [dict(r) for r in rows]})
    finally:
        conn.close()


@cctv_bp.route('/api/cctv/groups', methods=['POST'])
@_login_required
def api_groups_create():
    data = request.get_json(force=True) or {}
    name = (data.get('name') or '').strip()
    desc = (data.get('description') or '').strip()
    # Only admin can create shared groups
    is_shared = 1 if (data.get('is_shared') and _is_admin()) else 0
    if not name:
        return jsonify({'ok': False, 'error': 'name required'}), 400
    uid = _current_user_id()
    conn = sampling_portal.get_db_connection()
    try:
        cur = conn.execute("""
            INSERT INTO cctv_groups (owner_user_id, name, description, is_shared)
            VALUES (%s,%s,%s,%s)
        """, (uid, name, desc, is_shared))
        conn.commit()
        return jsonify({'ok': True, 'id': cur.lastrowid})
    finally:
        conn.close()


@cctv_bp.route('/api/cctv/groups/<int:gid>', methods=['PUT'])
@_login_required
def api_groups_update(gid):
    data = request.get_json(force=True) or {}
    uid = _current_user_id()
    conn = sampling_portal.get_db_connection()
    try:
        row = conn.execute("SELECT owner_user_id, is_shared FROM cctv_groups WHERE id=%s", (gid,)).fetchone()
        if not row:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        # Permission: owner can edit; admin can edit any
        if not _is_admin() and int(row['owner_user_id']) != uid:
            return jsonify({'ok': False, 'error': 'forbidden'}), 403

        fields, params = [], []
        for k in ('name','description','sort_order'):
            if k in data:
                fields.append(f"{k}=%s")
                params.append(data[k])
        # Only admin can flip is_shared
        if 'is_shared' in data and _is_admin():
            fields.append("is_shared=%s")
            params.append(1 if data['is_shared'] else 0)
        if not fields:
            return jsonify({'ok': False, 'error': 'no fields'}), 400
        params.append(gid)
        conn.execute(f"UPDATE cctv_groups SET {', '.join(fields)} WHERE id=%s", params)
        conn.commit()
        return jsonify({'ok': True})
    finally:
        conn.close()


@cctv_bp.route('/api/cctv/groups/<int:gid>', methods=['DELETE'])
@_login_required
def api_groups_delete(gid):
    uid = _current_user_id()
    conn = sampling_portal.get_db_connection()
    try:
        row = conn.execute("SELECT owner_user_id FROM cctv_groups WHERE id=%s", (gid,)).fetchone()
        if not row:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        if not _is_admin() and int(row['owner_user_id']) != uid:
            return jsonify({'ok': False, 'error': 'forbidden'}), 403
        conn.execute("DELETE FROM cctv_groups WHERE id=%s", (gid,))
        conn.commit()
        return jsonify({'ok': True})
    finally:
        conn.close()


@cctv_bp.route('/api/cctv/groups/<int:gid>/cameras', methods=['GET'])
@_login_required
def api_group_cameras(gid):
    """Cameras in a group, in display order, with recorder info."""
    conn = sampling_portal.get_db_connection()
    try:
        rows = conn.execute("""
            SELECT c.id, c.recorder_id, c.channel, c.name, c.location, c.department,
                   c.ai_enabled, c.is_active, cg.position,
                   r.name AS recorder_name, r.kind AS recorder_kind,
                   r.ip AS recorder_ip, r.rtsp_template
            FROM cctv_camera_groups cg
            JOIN cctv_cameras c   ON c.id = cg.camera_id
            JOIN cctv_recorders r ON r.id = c.recorder_id
            WHERE cg.group_id=%s AND c.is_active=1
            ORDER BY cg.position
        """, (gid,)).fetchall()
        return jsonify({'ok': True, 'cameras': [dict(r) for r in rows]})
    finally:
        conn.close()


@cctv_bp.route('/api/cctv/groups/<int:gid>/cameras', methods=['PUT'])
@_login_required
def api_group_cameras_set(gid):
    """Replace the camera list for a group. Body: {camera_ids:[int,...]}."""
    data = request.get_json(force=True) or {}
    cam_ids = data.get('camera_ids') or []
    if not isinstance(cam_ids, list):
        return jsonify({'ok': False, 'error': 'camera_ids must be a list'}), 400

    uid = _current_user_id()
    conn = sampling_portal.get_db_connection()
    try:
        row = conn.execute("SELECT owner_user_id FROM cctv_groups WHERE id=%s", (gid,)).fetchone()
        if not row:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        if not _is_admin() and int(row['owner_user_id']) != uid:
            return jsonify({'ok': False, 'error': 'forbidden'}), 403

        conn.execute("DELETE FROM cctv_camera_groups WHERE group_id=%s", (gid,))
        for pos, cid in enumerate(cam_ids):
            try:
                conn.execute("""
                    INSERT INTO cctv_camera_groups (group_id, camera_id, position)
                    VALUES (%s,%s,%s)
                """, (gid, int(cid), pos))
            except Exception:
                continue
        conn.commit()
        return jsonify({'ok': True, 'count': len(cam_ids)})
    except Exception as e:
        conn.rollback()
        return jsonify({'ok': False, 'error': str(e)}), 500
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# Stream URL endpoints
# ─────────────────────────────────────────────────────────────────────────────
@cctv_bp.route('/api/cctv/cameras/<int:cam_id>/stream')
@_login_required
def api_camera_stream(cam_id):
    """
    Returns a streaming URL the browser can play.
    By default we return the go2rtc WebRTC endpoint:
        http://<go2rtc_host>:1984/stream.html?src=cam_<id>&mode=webrtc

    For playback (with start/end query params), we return a direct RTSP
    URL — go2rtc will need to add it dynamically, or the caller can use
    /api/cctv/cameras/<id>/rtsp for the raw URL.
    """
    stream_kind = request.args.get('stream', 'sub')   # main / sub
    conn = sampling_portal.get_db_connection()
    try:
        row = conn.execute("""
            SELECT c.channel, r.id AS rid, r.name AS rname
            FROM cctv_cameras c
            JOIN cctv_recorders r ON r.id = c.recorder_id
            WHERE c.id=%s
        """, (cam_id,)).fetchone()
        if not row:
            return jsonify({'ok': False, 'error': 'camera not found'}), 404
        # go2rtc stream name convention: cam_<camera_id>_main / cam_<camera_id>_sub
        src = f"cam_{cam_id}_{stream_kind}"
        return jsonify({
            'ok': True,
            'src': src,
            'webrtc_url': f"/cctv/proxy/stream.html?src={src}&mode=webrtc",
            'mse_url':    f"/cctv/proxy/stream.html?src={src}&mode=mse",
            'snapshot_url': f"/cctv/proxy/api/frame.jpeg?src={src}",
        })
    finally:
        conn.close()


@cctv_bp.route('/api/cctv/cameras/<int:cam_id>/rtsp')
@_admin_required
def api_camera_rtsp(cam_id):
    """
    Return raw RTSP URLs for live + playback. Admin-only because it
    contains the password. Used by the go2rtc config generator.
    """
    conn = sampling_portal.get_db_connection()
    try:
        row = conn.execute("""
            SELECT c.channel, r.*
            FROM cctv_cameras c JOIN cctv_recorders r ON r.id=c.recorder_id
            WHERE c.id=%s
        """, (cam_id,)).fetchone()
        if not row:
            return jsonify({'ok': False, 'error': 'not found'}), 404
        rec = dict(row)
        ch = int(rec['channel'])
        return jsonify({
            'ok': True,
            'main': build_rtsp_url(rec, ch, 'main'),
            'sub':  build_rtsp_url(rec, ch, 'sub'),
        })
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# go2rtc config generator
# ─────────────────────────────────────────────────────────────────────────────
@cctv_bp.route('/api/cctv/go2rtc/config')
@_admin_required
def api_go2rtc_config():
    """
    Generate a go2rtc.yaml fragment for all active cameras.
    Naming convention: cam_<id>_main and cam_<id>_sub.
    Save to disk and restart go2rtc to pick up changes.
    """
    conn = sampling_portal.get_db_connection()
    try:
        rows = conn.execute("""
            SELECT c.id, c.channel, c.name, c.is_active,
                   r.ip, r.rtsp_port, r.username, r.password_enc,
                   r.encryption_key_enc, r.rtsp_template
            FROM cctv_cameras c JOIN cctv_recorders r ON r.id=c.recorder_id
            WHERE c.is_active=1 AND r.is_active=1
            ORDER BY c.id
        """).fetchall()

        lines = [
            "# Auto-generated by HCP portal — do not edit by hand.",
            "# Regenerate via /api/cctv/go2rtc/config (admin).",
            "api:",
            "  listen: \":1984\"",
            "webrtc:",
            "  candidates:",
            "    - stun:8555",
            "streams:",
        ]
        for row in rows:
            r = dict(row)
            main = build_rtsp_url(r, r['channel'], 'main')
            sub  = build_rtsp_url(r, r['channel'], 'sub')
            lines.append(f"  cam_{r['id']}_main: {main}")
            lines.append(f"  cam_{r['id']}_sub:  {sub}")

        return jsonify({'ok': True, 'yaml': "\n".join(lines), 'count': len(rows)})
    finally:
        conn.close()


# ─────────────────────────────────────────────────────────────────────────────
# go2rtc lifecycle — detect / install / start / stop / sync / log
# ─────────────────────────────────────────────────────────────────────────────
@cctv_bp.route('/api/cctv/go2rtc/status')
@_login_required
def api_go2rtc_status():
    """Live status — used by the admin UI to drive the service panel."""
    return jsonify({'ok': True, 'status': g2m.detect_go2rtc()})


@cctv_bp.route('/api/cctv/go2rtc/install', methods=['POST'])
@_admin_required
def api_go2rtc_install():
    """Download + extract go2rtc.exe to GO2RTC_DIR."""
    r = g2m.install_go2rtc()
    return jsonify(r), (200 if r.get('ok') else 500)


@cctv_bp.route('/api/cctv/go2rtc/sync', methods=['POST'])
@_admin_required
def api_go2rtc_sync():
    """Regenerate go2rtc.yaml from DB. Optionally restart go2rtc to pick up changes."""
    restart = bool((request.get_json(silent=True) or {}).get('restart'))
    res = g2m.write_config_from_db(sampling_portal.get_db_connection, build_rtsp_url)
    if not res.get('ok'):
        return jsonify(res), 500
    if restart:
        g2m.stop_go2rtc()
        s = g2m.start_go2rtc()
        res['restart'] = s
    return jsonify(res)


@cctv_bp.route('/api/cctv/go2rtc/start', methods=['POST'])
@_admin_required
def api_go2rtc_start():
    return jsonify(g2m.start_go2rtc())


@cctv_bp.route('/api/cctv/go2rtc/stop', methods=['POST'])
@_admin_required
def api_go2rtc_stop():
    return jsonify(g2m.stop_go2rtc())


@cctv_bp.route('/api/cctv/go2rtc/log')
@_admin_required
def api_go2rtc_log():
    n = int(request.args.get('lines', 50))
    return jsonify({'ok': True, 'log': g2m.tail_log(n)})


@cctv_bp.route('/cctv/go2rtc/install_service.bat')
@_admin_required
def api_go2rtc_install_service_bat():
    """Download a .bat the user runs as Administrator to install the service."""
    bat = g2m.generate_service_install_bat()
    return Response(
        bat, mimetype='application/x-bat',
        headers={'Content-Disposition': 'attachment; filename=hcp_go2rtc_install_service.bat'}
    )


@cctv_bp.route('/cctv/go2rtc/uninstall_service.bat')
@_admin_required
def api_go2rtc_uninstall_service_bat():
    bat = g2m.generate_service_uninstall_bat()
    return Response(
        bat, mimetype='application/x-bat',
        headers={'Content-Disposition': 'attachment; filename=hcp_go2rtc_uninstall_service.bat'}
    )


# ─────────────────────────────────────────────────────────────────────────────
# Reverse-proxy to go2rtc — so the browser doesn't need to know go2rtc's host
# ─────────────────────────────────────────────────────────────────────────────
GO2RTC_BASE = "http://127.0.0.1:1984"   # set via env in production

@cctv_bp.route('/cctv/proxy/<path:subpath>', methods=['GET', 'POST'])
@_login_required
def cctv_proxy(subpath):
    """
    Lightweight reverse proxy to go2rtc HTTP endpoints (frame snapshots,
    stream player page). WebRTC signaling needs WebSocket — for that the
    browser still talks directly to go2rtc, see cctv_live_wall.html.
    """
    import requests as _req
    try:
        url = f"{GO2RTC_BASE}/{subpath}"
        if request.query_string:
            url += '?' + request.query_string.decode('utf-8')
        if request.method == 'GET':
            r = _req.get(url, stream=True, timeout=10)
        else:
            r = _req.post(url, data=request.get_data(), timeout=10)
        from flask import Response
        return Response(r.content, status=r.status_code,
                        content_type=r.headers.get('Content-Type', 'application/octet-stream'))
    except Exception as e:
        return jsonify({'ok': False, 'error': str(e)}), 502
