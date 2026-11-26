GRANT USAGE ON SCHEMA line_pulse_v2 TO line_pulse_api, line_pulse_worker;
GRANT SELECT, INSERT, UPDATE ON line_pulse_v2.users, line_pulse_v2.machines, line_pulse_v2.modules,
    line_pulse_v2.module_mapping_versions TO line_pulse_api;
GRANT SELECT, INSERT ON line_pulse_v2.plc_endpoints, line_pulse_v2.collector_commands TO line_pulse_api;
GRANT SELECT, INSERT, DELETE ON line_pulse_v2.user_sessions, line_pulse_v2.module_signal_mappings TO line_pulse_api;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA line_pulse_v2 TO line_pulse_api;
GRANT SELECT ON line_pulse_v2.plc_samples, line_pulse_v2.plc_events, line_pulse_v2.plc_collection_errors,
    line_pulse_v2.plc_protocol_frames, line_pulse_v2.collector_state TO line_pulse_api;
GRANT SELECT ON line_pulse_v2.machines, line_pulse_v2.modules, line_pulse_v2.plc_endpoints,
    line_pulse_v2.module_mapping_versions, line_pulse_v2.module_signal_mappings,
    line_pulse_v2.collector_commands, line_pulse_v2.collector_state TO line_pulse_worker;
GRANT UPDATE (status, finished_at, result) ON line_pulse_v2.collector_commands TO line_pulse_worker;
GRANT INSERT, UPDATE ON line_pulse_v2.collector_state TO line_pulse_worker;
GRANT INSERT ON line_pulse_v2.plc_samples, line_pulse_v2.plc_events, line_pulse_v2.plc_collection_errors,
    line_pulse_v2.plc_protocol_frames TO line_pulse_worker;
GRANT SELECT (observed_at, poll_id) ON line_pulse_v2.plc_samples, line_pulse_v2.plc_collection_errors TO line_pulse_worker;
GRANT EXECUTE ON FUNCTION line_pulse_v2.maintain_partitions() TO line_pulse_worker;
GRANT SELECT, INSERT ON line_pulse_v2.archived_plc_samples TO line_pulse_api;
