import csv
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import server
from server import load_saved_readings


class SavedReadingsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.discovery = self.root / "discovery"
        self.discovery.mkdir()

    def write_csv(self, path, header, rows):
        with path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(header)
            writer.writerows(rows)

    def test_newest_complete_counts_win_without_op50_guess(self):
        raw = self.root / "raw_samples.csv"
        self.write_csv(raw,
            ("module_name", "module_ip", "observed_at_local", "ok_total", "ng_total"),
            (("OP10", "192.168.1.71", "2026-10-26T15:57:40+05:30", 153, 2),
             ("OP30", "192.168.1.41", "2026-10-26T15:57:45+05:30", 137, 0),
             ("OP40", "192.168.1.46", "2026-10-26T15:57:46+05:30", "", ""),
             ("OP50A", "192.168.1.51", "2026-10-26T15:57:47+05:30", 12336, 12594)))
        self.write_csv(self.discovery / "op40_20261023_113624.csv",
            ("module_name", "module_ip", "observed_at_local", "device", "value"),
            (("OP40", "192.168.1.46", "2026-10-23T11:51:14+05:30", "D400", 117),
             ("OP40", "192.168.1.46", "2026-10-23T11:51:14+05:30", "D404", 1),
             ("OP40", "192.168.1.46", "2026-10-23T11:52:14+05:30", "D400", 999)))
        saved = load_saved_readings(raw, self.discovery)
        self.assertEqual(saved["OP10"]["ok_total"], 153)
        self.assertEqual(saved["OP30"]["ng_total"], 0)
        self.assertEqual(saved["OP40"]["ok_total"], 117)
        self.assertEqual(saved["OP40"]["ng_total"], 1)
        self.assertNotIn("OP50A", saved)

    def test_missing_files_do_not_become_zero(self):
        self.assertEqual(load_saved_readings(self.root / "missing.csv", self.discovery), {})

    def test_live_capture_creates_station_csv_with_raw_values(self):
        runtime = server.DashboardRuntime()
        runtime.modules = [
            module for module in runtime.modules if module["name"] == "OP40"
        ]
        values = {
            "cycle_start": 1, "cycle_complete": 0, "cycle_time": 14,
            "ok_total": 118, "ng_total": 1,
        }

        def read_without_plc(*_args, **_kwargs):
            runtime.stop_event.set()
            return values

        with mock.patch.object(server, "DATA_ROOT", self.root), mock.patch.object(
            server.collector, "read_snapshot", side_effect=read_without_plc
        ):
            runtime._collection_loop()

        station_csv = self.root / "modules" / "op40.csv"
        with station_csv.open(newline="", encoding="utf-8") as handle:
            rows = list(csv.DictReader(handle))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["module_name"], "OP40")
        self.assertEqual(rows[0]["ok_total"], "118")
        self.assertEqual(rows[0]["ng_total"], "1")
        self.assertEqual(json.loads(rows[0]["raw_json"]), values)
        self.assertEqual(runtime.snapshot()["successful_samples"], 1)

    def test_collection_can_start_with_one_online_endpoint(self):
        runtime = server.DashboardRuntime()

        def check_without_network():
            runtime.connection_status = {
                "192.168.1.46": {"online": True},
                "192.168.1.51": {"online": False},
            }
            return {}

        with mock.patch.object(runtime, "check_connections", check_without_network), \
                mock.patch.object(runtime, "_collection_loop"):
            started, _message = runtime.start()
            runtime.stop()
        self.assertTrue(started)


if __name__ == "__main__":
    unittest.main()
