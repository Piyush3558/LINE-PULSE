import csv
import tempfile
import unittest
from pathlib import Path

from fx5_compare_captures import compare, load_capture


class CompareCapturesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def capture(self, name, samples, module="OP50"):
        path = self.root / name
        with path.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(("observed_at_utc", "observed_at_local", "sample_number",
                             "module_name", "module_ip", "device", "value"))
            for sample_number, devices in enumerate(samples, 1):
                for device, value in devices.items():
                    writer.writerow(("utc", f"local-{sample_number}", sample_number,
                                     module, "192.168.1.51", device, value))
        return path

    def test_hmi_match_and_zero_are_distinct(self):
        baseline = self.capture("baseline.csv", [
            {"D10": 2331, "D11": 3132, "D12": 0, "M15": 0},
            {"D10": 2331, "D11": 3132, "D12": 0, "M15": 0},
        ])
        running = self.capture("running.csv", [
            {"D10": 2332, "D11": 3132, "D12": 0, "M15": 1},
            {"D10": 2333, "D11": 3133, "D12": 0, "M15": 0},
        ])
        output = self.root / "comparison.csv"
        rows = compare(baseline, running, output, 2331, 2333, 3132, 3133)
        by_device = {row["device"]: row for row in rows}
        self.assertEqual(by_device["D10"]["candidate"], "OK total+delta match")
        self.assertEqual(by_device["D11"]["candidate"], "NG total+delta match")
        self.assertEqual(by_device["D12"]["delta"], 0)
        self.assertEqual(by_device["D12"]["candidate"], "")
        self.assertEqual(by_device["M15"]["running_changes"], 1)
        self.assertTrue(output.exists())
        with output.open(newline="", encoding="utf-8") as handle:
            written = list(csv.DictReader(handle))
        self.assertEqual({row["device"] for row in written}, {"D10", "D11", "M15"})

    def test_mismatch_and_empty_capture_are_rejected(self):
        baseline = self.capture("baseline.csv", [{"D10": 1}])
        other = self.capture("other.csv", [{"D10": 2}], module="OP40")
        with self.assertRaisesRegex(ValueError, "Capture mismatch"):
            compare(baseline, other, self.root / "comparison.csv")
        empty = self.capture("empty.csv", [])
        with self.assertRaisesRegex(ValueError, "no successful samples"):
            load_capture(empty)

    def test_different_address_plans_are_rejected(self):
        baseline = self.capture("baseline.csv", [{"D10": 1, "D11": 2}])
        running = self.capture("running.csv", [{"D10": 2}])
        with self.assertRaisesRegex(ValueError, "Device sets differ"):
            compare(baseline, running, self.root / "comparison.csv")


if __name__ == "__main__":
    unittest.main()
