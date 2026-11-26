CREATE SCHEMA line_pulse_v2;
SET LOCAL search_path = line_pulse_v2, pg_catalog;

CREATE TABLE users (
    user_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username text NOT NULL UNIQUE CHECK (username = lower(username) AND length(username) BETWEEN 1 AND 80),
    password_hash text NOT NULL,
    role text NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
    enabled boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_sessions (
    session_token_hash text PRIMARY KEY,
    user_id bigint NOT NULL REFERENCES users,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
);
CREATE TABLE machines (
    machine_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    machine_code text NOT NULL UNIQUE CHECK (machine_code ~ '^[A-Z0-9_-]{1,40}$'),
    machine_name text NOT NULL CHECK (length(btrim(machine_name)) BETWEEN 1 AND 120),
    time_zone text NOT NULL,
    poll_interval_seconds integer NOT NULL DEFAULT 5 CHECK (poll_interval_seconds BETWEEN 2 AND 3600),
    collector_key uuid,
    enabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE modules (
    module_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    machine_id bigint NOT NULL REFERENCES machines,
    module_code text NOT NULL CHECK (module_code ~ '^[A-Z0-9_-]{1,40}$'),
    display_order integer NOT NULL CHECK (display_order >= 0),
    enabled boolean NOT NULL DEFAULT false,
    active_mapping_version_id bigint,
    UNIQUE (machine_id, module_code),
    UNIQUE (machine_id, module_id)
);
CREATE TABLE plc_endpoints (
    endpoint_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    machine_id bigint NOT NULL REFERENCES machines,
    ip_address inet NOT NULL CHECK (masklen(ip_address) = CASE family(ip_address) WHEN 4 THEN 32 ELSE 128 END),
    port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
    unit_id smallint NOT NULL CHECK (unit_id BETWEEN 0 AND 255),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (machine_id, ip_address, port, unit_id),
    UNIQUE (machine_id, endpoint_id)
);
CREATE TABLE module_mapping_versions (
    mapping_version_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    machine_id bigint NOT NULL REFERENCES machines,
    module_id bigint NOT NULL,
    endpoint_id bigint NOT NULL,
    version_number integer NOT NULL CHECK (version_number > 0),
    purpose text NOT NULL CHECK (purpose IN ('commissioning', 'production')),
    created_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    published_by bigint REFERENCES users,
    CHECK ((published_at IS NULL) = (published_by IS NULL)),
    UNIQUE (module_id, version_number),
    UNIQUE (module_id, mapping_version_id),
    FOREIGN KEY (machine_id, module_id) REFERENCES modules (machine_id, module_id),
    FOREIGN KEY (machine_id, endpoint_id) REFERENCES plc_endpoints (machine_id, endpoint_id)
);
ALTER TABLE modules ADD FOREIGN KEY (module_id, active_mapping_version_id)
    REFERENCES module_mapping_versions (module_id, mapping_version_id);
CREATE TABLE module_signal_mappings (
    mapping_version_id bigint NOT NULL REFERENCES module_mapping_versions ON DELETE CASCADE,
    signal_code text NOT NULL CHECK (signal_code ~ '^[a-z][a-z0-9_]{0,63}$'),
    plc_device text NOT NULL,
    function_code smallint NOT NULL CHECK (function_code IN (1, 3)),
    pdu_address integer NOT NULL CHECK (pdu_address BETWEEN 0 AND 65535),
    data_type text NOT NULL CHECK (data_type IN ('bool', 'uint16', 'int16', 'uint32', 'int32')),
    word_order text CHECK (word_order IN ('high_word_first', 'low_word_first')),
    scale_factor numeric CHECK (scale_factor > 0 AND scale_factor < 'Infinity'::numeric),
    engineering_unit text,
    verification_status text NOT NULL,
    evidence_reference text,
    PRIMARY KEY (mapping_version_id, signal_code),
    CHECK ((function_code = 1) = (data_type = 'bool')),
    CHECK ((data_type IN ('uint32', 'int32')) = (word_order IS NOT NULL)),
    CHECK (data_type NOT IN ('uint32', 'int32') OR pdu_address < 65535)
);
CREATE FUNCTION protect_mapping() RETURNS trigger LANGUAGE plpgsql
SET search_path = line_pulse_v2, pg_catalog AS $$
BEGIN
    IF TG_OP <> 'INSERT' AND OLD.published_at IS NOT NULL THEN
        RAISE EXCEPTION 'Published mapping versions are immutable';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF NEW.published_at IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM module_signal_mappings WHERE mapping_version_id = NEW.mapping_version_id AND signal_code = 'cycle_start' AND data_type = 'bool')
           OR NOT EXISTS (SELECT 1 FROM module_signal_mappings WHERE mapping_version_id = NEW.mapping_version_id AND signal_code = 'cycle_complete' AND data_type = 'bool') THEN
            RAISE EXCEPTION 'Start and completion bits are required';
        END IF;
        IF NEW.purpose = 'production' AND EXISTS (
            SELECT 1 FROM module_signal_mappings WHERE mapping_version_id = NEW.mapping_version_id
            AND (verification_status <> 'verified' OR nullif(btrim(evidence_reference), '') IS NULL)
        ) THEN
            RAISE EXCEPTION 'Production signals require verification evidence';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER mapping_guard BEFORE INSERT OR UPDATE OR DELETE ON module_mapping_versions
    FOR EACH ROW EXECUTE FUNCTION protect_mapping();
CREATE FUNCTION protect_signal() RETURNS trigger LANGUAGE plpgsql
SET search_path = line_pulse_v2, pg_catalog AS $$
DECLARE parent_id bigint;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.mapping_version_id <> NEW.mapping_version_id THEN
        RAISE EXCEPTION 'Signals cannot move between mapping versions';
    END IF;
    parent_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.mapping_version_id ELSE NEW.mapping_version_id END;
    IF (SELECT published_at FROM module_mapping_versions WHERE mapping_version_id = parent_id FOR UPDATE) IS NOT NULL THEN
        RAISE EXCEPTION 'Published signals are immutable';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER signal_guard BEFORE INSERT OR UPDATE OR DELETE ON module_signal_mappings
    FOR EACH ROW EXECUTE FUNCTION protect_signal();
CREATE FUNCTION check_active_mapping() RETURNS trigger LANGUAGE plpgsql
SET search_path = line_pulse_v2, pg_catalog AS $$
BEGIN
    IF NEW.active_mapping_version_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM module_mapping_versions WHERE module_id = NEW.module_id
        AND mapping_version_id = NEW.active_mapping_version_id AND published_at IS NOT NULL
    ) THEN RAISE EXCEPTION 'Active mapping must be published for this module'; END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER active_mapping_guard BEFORE INSERT OR UPDATE OF active_mapping_version_id ON modules
    FOR EACH ROW EXECUTE FUNCTION check_active_mapping();

CREATE TABLE plc_samples (
    observed_at timestamptz NOT NULL,
    poll_id uuid NOT NULL,
    module_id bigint NOT NULL,
    mapping_version_id bigint NOT NULL,
    stored_at timestamptz NOT NULL DEFAULT now(),
    cycle_start boolean,
    cycle_complete boolean,
    cycle_time_raw bigint,
    cycle_time_seconds numeric,
    ok_total bigint,
    ng_total bigint,
    raw_values jsonb NOT NULL CHECK (jsonb_typeof(raw_values) = 'object'),
    PRIMARY KEY (observed_at, poll_id),
    FOREIGN KEY (module_id, mapping_version_id) REFERENCES module_mapping_versions (module_id, mapping_version_id)
) PARTITION BY RANGE (observed_at);
CREATE TABLE plc_events (
    observed_at timestamptz NOT NULL,
    poll_id uuid NOT NULL,
    event_type text NOT NULL,
    counter_value bigint,
    counter_delta bigint,
    observed_cycle_seconds numeric,
    details jsonb NOT NULL DEFAULT '{}',
    PRIMARY KEY (observed_at, poll_id, event_type),
    FOREIGN KEY (observed_at, poll_id) REFERENCES plc_samples
) PARTITION BY RANGE (observed_at);
CREATE TABLE plc_collection_errors (
    observed_at timestamptz NOT NULL,
    poll_id uuid NOT NULL,
    module_id bigint NOT NULL,
    mapping_version_id bigint NOT NULL,
    stored_at timestamptz NOT NULL DEFAULT now(),
    error_code text NOT NULL,
    error_message text NOT NULL,
    PRIMARY KEY (observed_at, poll_id),
    FOREIGN KEY (module_id, mapping_version_id) REFERENCES module_mapping_versions (module_id, mapping_version_id)
) PARTITION BY RANGE (observed_at);
CREATE TABLE plc_protocol_frames (
    observed_at timestamptz NOT NULL,
    poll_id uuid NOT NULL,
    frame_number integer NOT NULL CHECK (frame_number > 0),
    transaction_id integer NOT NULL CHECK (transaction_id BETWEEN 0 AND 65535),
    function_code smallint NOT NULL CHECK (function_code IN (1, 3)),
    start_address integer NOT NULL CHECK (start_address BETWEEN 0 AND 65535),
    quantity integer NOT NULL CHECK (quantity > 0),
    request_adu bytea NOT NULL,
    response_adu bytea NOT NULL,
    PRIMARY KEY (observed_at, poll_id, frame_number),
    FOREIGN KEY (observed_at, poll_id) REFERENCES plc_samples
) PARTITION BY RANGE (observed_at);
CREATE INDEX samples_module_time ON plc_samples (module_id, observed_at DESC, poll_id DESC);
CREATE INDEX errors_module_time ON plc_collection_errors (module_id, observed_at DESC);

CREATE TABLE collector_state (
    machine_id bigint PRIMARY KEY REFERENCES machines,
    status text NOT NULL CHECK (status IN ('stopped', 'running', 'blocked')),
    heartbeat_at timestamptz NOT NULL,
    last_upload_at timestamptz,
    pending_polls integer NOT NULL CHECK (pending_polls >= 0)
);
CREATE TABLE collector_commands (
    command_id uuid PRIMARY KEY,
    machine_id bigint NOT NULL REFERENCES machines,
    action text NOT NULL CHECK (action IN ('check', 'start', 'stop')),
    status text NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'failed', 'expired')),
    requested_by bigint NOT NULL REFERENCES users,
    requested_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    finished_at timestamptz,
    result jsonb
);
CREATE INDEX commands_pending ON collector_commands (machine_id, requested_at) WHERE status = 'pending';

CREATE FUNCTION ensure_partitions(month_start date) RETURNS void
LANGUAGE plpgsql SET search_path = line_pulse_v2, pg_catalog AS $$
DECLARE
    parent_name text;
    month_end date := (month_start + interval '1 month')::date;
BEGIN
    IF extract(day FROM month_start) <> 1 THEN RAISE EXCEPTION 'Use the first day of a UTC month'; END IF;
    FOREACH parent_name IN ARRAY ARRAY['plc_samples','plc_collection_errors','plc_events','plc_protocol_frames'] LOOP
        EXECUTE format('CREATE TABLE IF NOT EXISTS line_pulse_v2.%I PARTITION OF line_pulse_v2.%I FOR VALUES FROM (%L) TO (%L)',
            parent_name || '_' || to_char(month_start, 'YYYYMM'), parent_name,
            month_start::text || ' 00:00:00+00', month_end::text || ' 00:00:00+00');
    END LOOP;
END $$;
