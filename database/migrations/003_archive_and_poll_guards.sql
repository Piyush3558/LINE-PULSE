SET LOCAL search_path = line_pulse_v2, pg_catalog;

CREATE TABLE archived_plc_samples (
    archive_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    module_id bigint NOT NULL REFERENCES modules,
    endpoint_id bigint NOT NULL REFERENCES plc_endpoints,
    source_name text NOT NULL,
    source_sample_id text NOT NULL,
    observed_at timestamptz NOT NULL,
    cycle_start boolean,
    cycle_complete boolean,
    cycle_time_raw bigint,
    cycle_time_seconds numeric,
    ok_total bigint,
    ng_total bigint,
    mapping_status text NOT NULL,
    raw_values jsonb NOT NULL,
    UNIQUE (module_id, source_name, source_sample_id)
);
CREATE INDEX archive_module_time ON archived_plc_samples (module_id, observed_at DESC, archive_id DESC);

CREATE FUNCTION guard_poll_outcome() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = line_pulse_v2, pg_catalog AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.poll_id::text, 1566226003));
    IF NOT EXISTS (
        SELECT 1 FROM module_mapping_versions
        WHERE module_id=NEW.module_id AND mapping_version_id=NEW.mapping_version_id AND published_at IS NOT NULL
    ) THEN RAISE EXCEPTION 'Polls require a published mapping'; END IF;
    IF TG_ARGV[0]='sample' THEN
        IF EXISTS (SELECT 1 FROM plc_collection_errors WHERE observed_at=NEW.observed_at AND poll_id=NEW.poll_id)
        THEN RAISE EXCEPTION 'This poll already has an error'; END IF;
    ELSE
        IF EXISTS (SELECT 1 FROM plc_samples WHERE observed_at=NEW.observed_at AND poll_id=NEW.poll_id)
        THEN RAISE EXCEPTION 'This poll already has a sample'; END IF;
    END IF;
    RETURN NEW;
END $$;
REVOKE EXECUTE ON FUNCTION guard_poll_outcome() FROM PUBLIC;
CREATE TRIGGER sample_outcome_guard BEFORE INSERT ON plc_samples
    FOR EACH ROW EXECUTE FUNCTION guard_poll_outcome('sample');
CREATE TRIGGER error_outcome_guard BEFORE INSERT ON plc_collection_errors
    FOR EACH ROW EXECUTE FUNCTION guard_poll_outcome('error');
