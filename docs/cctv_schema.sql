-- ──────────────────────────────────────────────────────────────────────────────
-- HCP CCTV Module — MySQL schema
-- Run once on the portal database. Idempotent (CREATE IF NOT EXISTS).
-- ──────────────────────────────────────────────────────────────────────────────

-- Recorders: DVR / NVR units. Password is XOR-obfuscated (same scheme as
-- tally_credentials in app.py — _obfuscate / _deobfuscate).
CREATE TABLE IF NOT EXISTS cctv_recorders (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    name            VARCHAR(120) NOT NULL,
    kind            ENUM('DVR','NVR') NOT NULL,
    ip              VARCHAR(45)  NOT NULL,
    rtsp_port       INT          NOT NULL DEFAULT 554,
    http_port       INT          NOT NULL DEFAULT 80,
    username        VARCHAR(120) NOT NULL,
    password_enc    VARCHAR(500) NOT NULL DEFAULT '',
    -- Optional Hikvision stream encryption key. Most LAN deployments leave this empty.
    -- If your NVR/DVR has "Stream Encryption" enabled (not just the Live View
    -- Parameters local key), put the key here and it will be appended as ?key= to
    -- the RTSP URL. XOR-obfuscated like password_enc.
    encryption_key_enc VARCHAR(500) NOT NULL DEFAULT '',
    channel_count   INT          NOT NULL DEFAULT 16,
    -- Hikvision RTSP path style. Modern firmware: /Streaming/Channels/{ch}0{stream}
    -- Older units (some DVRs): /h264/ch{ch}/{stream}/av_stream
    rtsp_template   VARCHAR(40)  NOT NULL DEFAULT 'modern',
    is_active       TINYINT(1)   NOT NULL DEFAULT 1,
    notes           VARCHAR(500) DEFAULT '',
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_recorder_ip (ip, rtsp_port)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Cameras: one row per channel on each recorder. Auto-generated when a
-- recorder is created (channel_count rows). User edits only name/location/flags.
CREATE TABLE IF NOT EXISTS cctv_cameras (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    recorder_id     INT          NOT NULL,
    channel         INT          NOT NULL,
    name            VARCHAR(160) NOT NULL DEFAULT '',
    location        VARCHAR(200) DEFAULT '',
    department      VARCHAR(60)  DEFAULT '',  -- Production / QC / Packing / Warehouse / etc.
    ai_enabled      TINYINT(1)   NOT NULL DEFAULT 0,
    is_active       TINYINT(1)   NOT NULL DEFAULT 1,
    sort_order      INT          NOT NULL DEFAULT 0,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_recorder_channel (recorder_id, channel),
    KEY idx_active (is_active),
    KEY idx_ai (ai_enabled),
    CONSTRAINT fk_cam_recorder FOREIGN KEY (recorder_id)
        REFERENCES cctv_recorders(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Groups: user-owned camera collections. Shared groups visible to all.
CREATE TABLE IF NOT EXISTS cctv_groups (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    owner_user_id   INT          NOT NULL,
    name            VARCHAR(120) NOT NULL,
    description     VARCHAR(300) DEFAULT '',
    is_shared       TINYINT(1)   NOT NULL DEFAULT 0,
    sort_order      INT          NOT NULL DEFAULT 0,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_owner (owner_user_id),
    KEY idx_shared (is_shared)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Many-to-many: cameras in groups, with explicit ordering for grid layout.
CREATE TABLE IF NOT EXISTS cctv_camera_groups (
    group_id        INT NOT NULL,
    camera_id       INT NOT NULL,
    position        INT NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, camera_id),
    KEY idx_position (group_id, position),
    CONSTRAINT fk_cg_group  FOREIGN KEY (group_id)  REFERENCES cctv_groups(id)  ON DELETE CASCADE,
    CONSTRAINT fk_cg_camera FOREIGN KEY (camera_id) REFERENCES cctv_cameras(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Zones: polygon regions inside a camera frame, used by Phase-2 AI worker.
-- polygon_json = '[{"x":0.12,"y":0.30}, ...]' with normalized coords (0..1).
CREATE TABLE IF NOT EXISTS cctv_zones (
    id              INT AUTO_INCREMENT PRIMARY KEY,
    camera_id       INT          NOT NULL,
    name            VARCHAR(120) NOT NULL,
    zone_type       ENUM('worker_station','packing_area','aisle','restricted','line') NOT NULL DEFAULT 'worker_station',
    polygon_json    TEXT         NOT NULL,
    min_persons     INT          NOT NULL DEFAULT 0,
    max_idle_sec    INT          NOT NULL DEFAULT 300,   -- alert if person present + still > N sec
    max_empty_sec   INT          NOT NULL DEFAULT 600,   -- alert if zone empty > N sec during active hours
    active_from     TIME         DEFAULT '09:00:00',
    active_to       TIME         DEFAULT '18:00:00',
    is_active       TINYINT(1)   NOT NULL DEFAULT 1,
    created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_camera (camera_id),
    CONSTRAINT fk_zone_camera FOREIGN KEY (camera_id) REFERENCES cctv_cameras(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Events: every alert from the AI worker.
CREATE TABLE IF NOT EXISTS cctv_events (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    camera_id       INT          NOT NULL,
    zone_id         INT          DEFAULT NULL,
    event_type      VARCHAR(40)  NOT NULL,    -- idle / empty_zone / overcrowding / intrusion / no_ppe / line_stoppage
    severity        ENUM('info','warning','critical') NOT NULL DEFAULT 'warning',
    started_at      DATETIME     NOT NULL,
    ended_at        DATETIME     DEFAULT NULL,
    person_count    INT          DEFAULT 0,
    snapshot_path   VARCHAR(400) DEFAULT '',
    notes           VARCHAR(500) DEFAULT '',
    acknowledged    TINYINT(1)   NOT NULL DEFAULT 0,
    acknowledged_by INT          DEFAULT NULL,
    acknowledged_at DATETIME     DEFAULT NULL,
    KEY idx_camera_time (camera_id, started_at),
    KEY idx_event_type (event_type),
    KEY idx_open (acknowledged, ended_at),
    CONSTRAINT fk_evt_camera FOREIGN KEY (camera_id) REFERENCES cctv_cameras(id) ON DELETE CASCADE,
    CONSTRAINT fk_evt_zone   FOREIGN KEY (zone_id)   REFERENCES cctv_zones(id)   ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
