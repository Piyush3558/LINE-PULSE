#!/usr/bin/env python3
"""One-pass, bounded FC03-only OP50 register capture; never writes to PLC."""

import csv
import time
from datetime import datetime
from pathlib import Path

from fx5_collector import CollectorError, ModbusTcpClient, iso_times


HOST = "192.168.1.51"
STARTS = range(64, 384, 32)  # D64..D383, one 32-register read per step.
QUANTITY = 32
INTERVAL_SECONDS = 10
OUTPUT_DIR = Path(__file__).resolve().parent / "discovery_data"


def main() -> int:
    OUTPUT_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    output = OUTPUT_DIR / f"op50_d64_d383_{stamp}.csv"
    print(f"Read-only OP50 {HOST}:502, FC03 D64..D383, one 32-register request every 10s")
    print(f"Output: {output}")
    with output.open("x", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(("observed_at_utc", "observed_at_local", "sample_number",
                         "module_name", "module_ip", "device", "value"))
        for sample, start in enumerate(STARTS, 1):
            started = time.monotonic()
            try:
                with ModbusTcpClient(HOST, 502, 1, 2.0) as plc:
                    values = plc.read_holding_registers(start, QUANTITY)
            except (OSError, CollectorError) as error:
                print(f"Read failed on sample {sample}; stopping: {error}")
                break
            utc_stamp, local_stamp = iso_times()
            for offset, value in enumerate(values):
                writer.writerow((utc_stamp, local_stamp, sample, "OP50", HOST,
                                 f"D{start + offset}", int(value)))
            handle.flush()
            print(f"{local_stamp}: D{start}..D{start + QUANTITY - 1} saved ({len(values)} values)", flush=True)
            remaining = INTERVAL_SECONDS - (time.monotonic() - started)
            if remaining > 0 and start + QUANTITY < STARTS.stop:
                time.sleep(remaining)
    print(f"Saved: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
