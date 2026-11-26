-- Legacy Python schema retained for rollback. New installations use database/migrations/.
-- Line Pulse local PostgreSQL schema. Run as the owner of database line_pulse.
-- These tables preserve PLC observations; a counter is not a per-part result.

CREATE SCHEMA IF NOT EXISTS line_pulse;

CREATE TABLE IF NOT EXISTS line_pulse.plc_samples (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('dashboard', 'collector')),
    observed_at_utc TIMESTAMPTZ NOT NULL,
    observed_at_local TEXT NOT NULL,
    module_name TEXT NOT NULL,
    module_ip INET NOT NULL,
    cycle_start BOOLEAN,
    cycle_complete BOOLEAN,
    cycle_time_raw BIGINT,
    cycle_time_seconds DOUBLE PRECISION,
    ok_total BIGINT,
    ng_total BIGINT,
    mapping_status TEXT NOT NULL,
    raw_values JSONB NOT NULL,
    stored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source, observed_at_utc, module_name)
);
CREATE INDEX IF NOT EXISTS plc_samples_module_time_idx
    ON line_pulse.plc_samples (module_name, observed_at_utc DESC);

CREATE TABLE IF NOT EXISTS line_pulse.protocol_frames (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sample_id BIGINT NOT NULL REFERENCES line_pulse.plc_samples(id),
    module_name TEXT NOT NULL,
    transaction_id INTEGER NOT NULL,
    function INTEGER NOT NULL CHECK (function IN (1, 2, 3, 4)),
    address INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    request_adu_hex TEXT NOT NULL,
    response_adu_hex TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS protocol_frames_sample_idx
    ON line_pulse.protocol_frames (sample_id);

CREATE TABLE IF NOT EXISTS line_pulse.events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('dashboard', 'collector')),
    observed_at_utc TIMESTAMPTZ NOT NULL,
    observed_at_local TEXT NOT NULL,
    module_name TEXT NOT NULL,
    event_type TEXT NOT NULL,
    value BIGINT,
    delta BIGINT,
    observed_cycle_seconds DOUBLE PRECISION,
    details JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS events_module_time_idx
    ON line_pulse.events (module_name, observed_at_utc DESC);

CREATE TABLE IF NOT EXISTS line_pulse.collection_errors (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    source TEXT NOT NULL CHECK (source IN ('dashboard', 'collector')),
    observed_at_utc TIMESTAMPTZ NOT NULL,
    observed_at_local TEXT NOT NULL,
    module_name TEXT NOT NULL,
    module_ip INET NOT NULL,
    error_type TEXT NOT NULL,
    error_message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS line_pulse.discovery_samples (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    capture_file TEXT NOT NULL,
    sample_number INTEGER NOT NULL CHECK (sample_number > 0),
    observed_at_utc TIMESTAMPTZ NOT NULL,
    observed_at_local TEXT NOT NULL,
    module_name TEXT NOT NULL,
    module_ip INET NOT NULL,
    stored_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (capture_file, sample_number, module_name)
);
CREATE INDEX IF NOT EXISTS discovery_samples_module_time_idx
    ON line_pulse.discovery_samples (module_name, observed_at_utc DESC);

CREATE TABLE IF NOT EXISTS line_pulse.discovery_values (
    sample_id BIGINT NOT NULL REFERENCES line_pulse.discovery_samples(id),
    device TEXT NOT NULL,
    value BIGINT NOT NULL,
    PRIMARY KEY (sample_id, device)
);

-- Future traceability. Leave empty until QR source and final OP50 event are verified.
CREATE TABLE IF NOT EXISTS line_pulse.parts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    qr_text TEXT NOT NULL UNIQUE,
    first_scanned_at TIMESTAMPTZ NOT NULL,
    final_result TEXT CHECK (final_result IN ('OK', 'NG') OR final_result IS NULL),
    final_result_at TIMESTAMPTZ,
    CHECK ((final_result IS NULL) = (final_result_at IS NULL))
);

CREATE TABLE IF NOT EXISTS line_pulse.station_visits (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    part_id BIGINT NOT NULL REFERENCES line_pulse.parts(id),
    module_name TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    result TEXT CHECK (result IN ('OK', 'NG', 'FAULT') OR result IS NULL),
    CHECK (completed_at IS NULL OR completed_at >= started_at)
);
CREATE INDEX IF NOT EXISTS station_visits_part_time_idx
    ON line_pulse.station_visits (part_id, started_at);
