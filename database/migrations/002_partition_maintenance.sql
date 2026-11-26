SET LOCAL search_path = line_pulse_v2, pg_catalog;
REVOKE EXECUTE ON FUNCTION ensure_partitions(date) FROM PUBLIC;
CREATE FUNCTION maintain_partitions() RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = line_pulse_v2, pg_catalog AS $$
DECLARE
    month_start date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
    offset_month integer;
    required_month date;
BEGIN
    FOR offset_month IN 0..2 LOOP
        required_month := (month_start + offset_month * interval '1 month')::date;
        IF EXISTS (
            SELECT 1 FROM unnest(ARRAY['plc_samples','plc_collection_errors','plc_events','plc_protocol_frames']) t(name)
            WHERE to_regclass('line_pulse_v2.' || t.name || '_' || to_char(required_month, 'YYYYMM')) IS NULL
        ) THEN
            PERFORM pg_advisory_xact_lock(1566226001);
            PERFORM ensure_partitions(required_month);
        END IF;
    END LOOP;
END $$;
REVOKE EXECUTE ON FUNCTION maintain_partitions() FROM PUBLIC;
