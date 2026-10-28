import json
import socket
import struct
import tempfile
import threading
import unittest
from pathlib import Path

import fx5_collector as collector
import fx5_audit_report
import fx5_report


class AddressMappingTests(unittest.TestCase):
    def test_signed_and_two_word_register_decoding(self):
        signed16 = collector.ResolvedSignal(
            "signed", "D1", 3, 1, "verified", "int16", "high_word_first"
        )
        uint32_high = collector.ResolvedSignal(
            "count", "D2", 3, 2, "verified", "uint32", "high_word_first"
        )
        uint32_low = collector.ResolvedSignal(
            "count", "D2", 3, 2, "verified", "uint32", "low_word_first"
        )
        self.assertEqual(collector.decode_register_value(signed16, [0xFFFF]), -1)
        self.assertEqual(
            collector.decode_register_value(uint32_high, [0x0001, 0x0002]),
            0x00010002,
        )
        self.assertEqual(
            collector.decode_register_value(uint32_low, [0x0001, 0x0002]),
            0x00020001,
        )

    def test_two_word_signal_expands_read_plan(self):
        signal = collector.ResolvedSignal(
            "count", "D400", 3, 400, "verified", "uint32", "low_word_first"
        )
        self.assertEqual(collector.planned_reads([signal]), [(3, 400, 2)])

    def test_fx5_default_m_devices_use_0x2000_offset(self):
        self.assertEqual(collector.resolve_device("M130", "fx5_dedicated_default"), (1, 8322))
        self.assertEqual(collector.resolve_device("M260", "fx5_dedicated_default"), (1, 8452))

    def test_fx5_default_d_devices_use_same_zero_based_address(self):
        self.assertEqual(collector.resolve_device("D16", "fx5_dedicated_default"), (3, 16))
        self.assertEqual(collector.resolve_device("D400", "fx5_dedicated_default"), (3, 400))
        self.assertEqual(collector.resolve_device("D404", "fx5_dedicated_default"), (3, 404))

    def test_register_ranges_are_bounded_and_group_nearby_devices(self):
        self.assertEqual(
            collector.grouped_ranges([16, 400, 404], max_gap=4, max_span=125),
            [(16, 1), (400, 5)],
        )

    def test_write_function_is_blocked_before_socket_use(self):
        client = collector.ModbusTcpClient("127.0.0.1", 502, 1, 1.0)
        with self.assertRaisesRegex(collector.CollectorError, "unsafe"):
            client._request(6, 0, 1)

    def test_exact_m130_request_bytes(self):
        request = collector.build_read_request_adu(1, 1, 1, 8322, 1)
        self.assertEqual(
            request.hex(" "),
            "00 01 00 00 00 06 01 01 20 82 00 01",
        )

    def test_snapshot_plan_contains_four_bounded_reads(self):
        example = Path(__file__).with_name("modules.example.json")
        config = json.loads(example.read_text(encoding="utf-8"))
        collector.validate_config(config)
        signals = collector.signals_for_module(config, config["modules"][0])
        self.assertEqual(
            collector.planned_reads(signals),
            [(1, 8322, 1), (1, 8452, 1), (3, 16, 1), (3, 400, 5)],
        )


class ConfigurationTests(unittest.TestCase):
    def test_unknown_or_disabled_module_selection_is_rejected(self):
        example = Path(__file__).with_name("modules.example.json")
        with self.assertRaisesRegex(collector.CollectorError, "Unknown module"):
            collector.run(
                example,
                once=True,
                validate_only=True,
                selected_modules={"DOES_NOT_EXIST"},
            )
        with self.assertRaisesRegex(collector.CollectorError, "disabled"):
            collector.run(
                example,
                once=True,
                validate_only=True,
                selected_modules={"OP10"},
            )

    def test_station_with_only_start_and_complete_is_valid(self):
        example = Path(__file__).with_name("modules.example.json")
        config = json.loads(example.read_text(encoding="utf-8"))
        config["signal_profiles"]["bits_only"] = {
            "mapping_profile": "fx5_dedicated_default",
            "cycle_time_scale_seconds": None,
            "signals": {
                "cycle_start": {"device": "M211", "data_type": "bool"},
                "cycle_complete": {"device": "M77", "data_type": "bool"},
            },
        }
        config["modules"][1]["signal_profile"] = "bits_only"
        collector.validate_config(config)

    def test_invalid_scale_and_out_of_range_two_word_signal_are_rejected(self):
        example = Path(__file__).with_name("modules.example.json")
        config = json.loads(example.read_text(encoding="utf-8"))
        config["signal_profiles"]["op10_candidate"][
            "cycle_time_scale_seconds"
        ] = 0
        with self.assertRaisesRegex(collector.CollectorError, "cycle-time scale"):
            collector.validate_config(config)

        config = json.loads(example.read_text(encoding="utf-8"))
        signal = config["signal_profiles"]["op10_candidate"]["signals"][
            "cycle_time"
        ]
        signal["device"] = "D7999"
        signal["data_type"] = "uint32"
        with self.assertRaisesRegex(collector.CollectorError, "beyond"):
            collector.validate_config(config)

    def test_example_configuration_validates_without_network(self):
        example = Path(__file__).with_name("modules.example.json")
        config = json.loads(example.read_text(encoding="utf-8"))
        collector.validate_config(config)
        signals = collector.signals_for_module(config, config["modules"][0])
        self.assertEqual({signal.name for signal in signals}, {
            "cycle_start", "cycle_complete", "cycle_time", "ok_total", "ng_total"
        })

    def test_enabled_placeholder_ip_is_rejected(self):
        example = Path(__file__).with_name("modules.example.json")
        config = json.loads(example.read_text(encoding="utf-8"))
        config["modules"][1]["ip"] = "REPLACE_WITH_IP"
        config["modules"][1]["enabled"] = True
        with self.assertRaisesRegex(collector.CollectorError, "Invalid enabled IP"):
            collector.validate_config(config)


class AuditReportTests(unittest.TestCase):
    def test_offline_audit_explains_request_and_unmapped_modules(self):
        example = Path(__file__).with_name("modules.example.json")
        config = json.loads(example.read_text(encoding="utf-8"))
        report = fx5_audit_report.build_report(config)
        self.assertIn("00 01 00 00 00 06 01 01 20 82 00 01", report)
        self.assertIn("M130", report)
        self.assertIn("OP20", report)
        self.assertIn("NOT ASSIGNED", report)
        self.assertIn("No successful sample is stored", report)

    def test_enabled_module_requires_explicit_signal_profile(self):
        example = Path(__file__).with_name("modules.example.json")
        config = json.loads(example.read_text(encoding="utf-8"))
        config["modules"][1]["ip"] = "192.168.1.76"
        config["modules"][1]["enabled"] = True
        with self.assertRaisesRegex(collector.CollectorError, "signal_profile"):
            collector.validate_config(config)


class ModbusIntegrationTests(unittest.TestCase):
    def test_one_snapshot_uses_only_expected_read_requests(self):
        requests = []
        ready = threading.Event()
        server_address = {}

        def receive_exact(connection, length):
            data = b""
            while len(data) < length:
                chunk = connection.recv(length - len(data))
                if not chunk:
                    raise RuntimeError("test client disconnected")
                data += chunk
            return data

        def serve():
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
                server.bind(("127.0.0.1", 0))
                server.listen(1)
                server_address["port"] = server.getsockname()[1]
                ready.set()
                connection, _ = server.accept()
                with connection:
                    for _ in range(4):
                        header = receive_exact(connection, 7)
                        transaction, protocol, length, unit = struct.unpack(
                            ">HHHB", header
                        )
                        pdu = receive_exact(connection, length - 1)
                        function, address, quantity = struct.unpack(">BHH", pdu)
                        requests.append((function, address, quantity))
                        if function == 1:
                            value = 1 if address == 8322 else 0
                            response_pdu = struct.pack(">BBB", 1, 1, value)
                        elif function == 3 and address == 16:
                            response_pdu = struct.pack(">BBH", 3, 2, 42)
                        elif function == 3 and address == 400:
                            response_pdu = struct.pack(
                                ">BBHHHHH", 3, 10, 17, 0, 0, 0, 19
                            )
                        else:
                            response_pdu = bytes([function | 0x80, 2])
                        response = struct.pack(
                            ">HHHB",
                            transaction,
                            protocol,
                            len(response_pdu) + 1,
                            unit,
                        ) + response_pdu
                        connection.sendall(response)

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        self.assertTrue(ready.wait(2), "local MODBUS test server did not start")

        example = Path(__file__).with_name("modules.example.json")
        config = json.loads(example.read_text(encoding="utf-8"))
        collector.validate_config(config)
        signals = collector.signals_for_module(config, config["modules"][0])
        module = {
            "name": "OP10",
            "ip": "127.0.0.1",
            "port": server_address["port"],
            "unit_id": 1,
        }
        snapshot = collector.read_snapshot(module, signals, timeout=1.0)
        thread.join(2)

        self.assertEqual(
            requests,
            [(1, 8322, 1), (1, 8452, 1), (3, 16, 1), (3, 400, 5)],
        )
        self.assertEqual(
            snapshot,
            {
                "cycle_start": True,
                "cycle_complete": False,
                "cycle_time": 42,
                "ok_total": 17,
                "ng_total": 19,
            },
        )

    def test_snapshot_captures_exact_read_only_frames(self):
        requests = []
        ready = threading.Event()
        server_address = {}

        def receive_exact(connection, length):
            data = b""
            while len(data) < length:
                data += connection.recv(length - len(data))
            return data

        def serve():
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as server:
                server.bind(("127.0.0.1", 0))
                server.listen(1)
                server_address["port"] = server.getsockname()[1]
                ready.set()
                connection, _ = server.accept()
                with connection:
                    for _ in range(4):
                        header = receive_exact(connection, 7)
                        transaction, protocol, length, unit = struct.unpack(
                            ">HHHB", header
                        )
                        pdu = receive_exact(connection, length - 1)
                        function, address, quantity = struct.unpack(">BHH", pdu)
                        requests.append((function, address, quantity))
                        if function == 1:
                            response_pdu = struct.pack(">BBB", 1, 1, 0)
                        else:
                            values = [0] * quantity
                            response_pdu = struct.pack(">BB", 3, quantity * 2) + struct.pack(
                                ">" + "H" * quantity, *values
                            )
                        connection.sendall(
                            struct.pack(
                                ">HHHB", transaction, protocol,
                                len(response_pdu) + 1, unit,
                            ) + response_pdu
                        )

        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        self.assertTrue(ready.wait(2))
        config = json.loads(
            Path(__file__).with_name("modules.example.json").read_text()
        )
        collector.validate_config(config)
        signals = collector.signals_for_module(config, config["modules"][0])
        frames = []
        collector.read_snapshot(
            {
                "name": "OP10",
                "ip": "127.0.0.1",
                "port": server_address["port"],
                "unit_id": 1,
            },
            signals,
            timeout=1.0,
            capture_frames=frames,
        )
        thread.join(2)
        self.assertEqual(len(frames), 4)
        self.assertEqual({frame.function for frame in frames}, {1, 3})
        self.assertTrue(all(frame.request_adu_hex for frame in frames))
        self.assertTrue(all(frame.response_adu_hex for frame in frames))


class ReportTests(unittest.TestCase):
    def test_bits_only_station_derives_events_without_counter_keys(self):
        state = collector.RuntimeState()
        first = {"cycle_start": False, "cycle_complete": False}
        second = {"cycle_start": True, "cycle_complete": False}
        collector.derive_events("OP50A", first, state, "u1", "l1")
        events = collector.derive_events("OP50A", second, state, "u2", "l2")
        self.assertEqual([event["event_type"] for event in events], ["CYCLE_START"])

    def test_first_sample_establishes_baseline_without_inventing_deltas(self):
        state = collector.RuntimeState()
        values = {
            "cycle_start": False,
            "cycle_complete": False,
            "cycle_time": 0,
            "ok_total": 500,
            "ng_total": 25,
        }
        events = collector.derive_events(
            "OP10",
            values,
            state,
            "2026-10-15T04:30:00+00:00",
            "2026-10-15T10:00:00+05:30",
        )
        self.assertEqual(
            [event["event_type"] for event in events],
            ["BASELINE_ESTABLISHED"],
        )
        self.assertIsNone(events[0]["delta"])

    def test_report_includes_module_with_errors_but_no_samples(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "test.sqlite3"
            database = collector.initialize_database(database_path)
            collector.store_collection_error(
                database,
                Path(temporary_directory) / "errors.csv",
                {"name": "OP20", "ip": "192.168.1.76"},
                TimeoutError("timed out"),
            )
            observed_date = database.execute(
                "SELECT substr(observed_at_local, 1, 10) FROM collection_errors"
            ).fetchone()[0]
            database.close()
            report = fx5_report.report_for_date(database_path, observed_date)
            self.assertEqual(len(report["modules"]), 1)
            module = report["modules"][0]
            self.assertEqual(module["module"], "OP20")
            self.assertEqual(module["collection_status"], "no_successful_sample")
            self.assertEqual(module["successful_sample_count"], 0)
            self.assertEqual(module["collection_error_count"], 1)

    def test_protocol_frames_are_linked_to_raw_sample(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            database = collector.initialize_database(
                Path(temporary_directory) / "test.sqlite3"
            )
            raw = {
                "observed_at_utc": "2026-10-15T04:30:00.000+00:00",
                "observed_at_local": "2026-10-15T10:00:00.000+05:30",
                "module_name": "OP10",
                "module_ip": "192.168.1.71",
                "cycle_start": 0,
                "cycle_complete": 0,
                "cycle_time_raw": 42,
                "cycle_time_seconds": None,
                "ok_total": 100,
                "ng_total": 5,
                "mapping_status": "candidate",
            }
            sample_id = collector.store_raw(
                database,
                Path(temporary_directory) / "raw.csv",
                raw,
                {"cycle_time": 42},
            )
            collector.store_protocol_frames(
                database,
                sample_id,
                "OP10",
                [collector.ProtocolFrame(1, 3, 16, 1, "request", "response")],
            )
            stored = database.execute(
                "SELECT sample_id, module_name, function, address, quantity, "
                "request_adu_hex, response_adu_hex FROM protocol_frames"
            ).fetchone()
            database.close()
            self.assertEqual(
                stored,
                (sample_id, "OP10", 3, 16, 1, "request", "response"),
            )

    def test_report_separates_current_total_from_observed_increase(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "test.sqlite3"
            database = collector.initialize_database(database_path)
            raw = {
                "observed_at_utc": "2026-10-15T04:30:00.000+00:00",
                "observed_at_local": "2026-10-15T10:00:00.000+05:30",
                "module_name": "OP10",
                "module_ip": "192.168.1.71",
                "cycle_start": 0,
                "cycle_complete": 0,
                "cycle_time_raw": 42,
                "cycle_time_seconds": None,
                "ok_total": 100,
                "ng_total": 5,
                "mapping_status": "candidate",
            }
            collector.store_raw(
                database,
                Path(temporary_directory) / "raw.csv",
                raw,
                {"ok_total": 100, "ng_total": 5},
            )
            event = {
                "observed_at_utc": raw["observed_at_utc"],
                "observed_at_local": raw["observed_at_local"],
                "module_name": "OP10",
                "event_type": "OK_COUNT_CHANGE",
                "value": 100,
                "delta": 2,
                "observed_cycle_seconds": None,
            }
            collector.store_event(
                database, Path(temporary_directory) / "events.csv", event
            )
            completed = {
                **event,
                "event_type": "CYCLE_COMPLETE",
                "value": None,
                "delta": None,
                "observed_cycle_seconds": 12.5,
            }
            collector.store_event(
                database, Path(temporary_directory) / "events.csv", completed
            )
            database.close()
            report = fx5_report.report_for_date(database_path, "2026-10-15")
            module = report["modules"][0]
            self.assertEqual(module["current_ok_total"], 100)
            self.assertEqual(module["observed_ok_increase"], 2)
            self.assertEqual(module["collection_error_count"], 0)
            self.assertEqual(module["successful_sample_count"], 1)
            self.assertEqual(module["observed_completed_cycles"], 1)
            self.assertEqual(module["observed_work_seconds"], 12.5)

    def test_collection_error_is_stored_with_timestamp_and_module(self):
        with tempfile.TemporaryDirectory() as temporary_directory:
            database_path = Path(temporary_directory) / "test.sqlite3"
            database = collector.initialize_database(database_path)
            row = collector.store_collection_error(
                database,
                Path(temporary_directory) / "errors.csv",
                {"name": "OP20", "ip": "192.168.1.76"},
                TimeoutError("timed out"),
            )
            stored = database.execute(
                "SELECT module_name, module_ip, error_type, error_message "
                "FROM collection_errors"
            ).fetchone()
            database.close()
            self.assertEqual(row["module_name"], "OP20")
            self.assertEqual(stored, ("OP20", "192.168.1.76", "TimeoutError", "timed out"))


if __name__ == "__main__":
    unittest.main()
