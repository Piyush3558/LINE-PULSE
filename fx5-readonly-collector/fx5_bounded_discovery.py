#!/usr/bin/env python3
"""Bounded, low-rate, read-only signal discovery for all line PLCs."""

from __future__ import annotations

import argparse
import csv
import sys
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from fx5_collector import CollectorError, ModbusTcpClient, iso_times


HERE = Path(__file__).resolve().parent
DEFAULT_OUTPUT = HERE / "discovery_data"

# Small allow-list tied to known signals. Meanings of unknown devices are not
# assumed. M uses FC01; D uses FC03. No write functions exist in this tool.
PLANS: dict[str, dict[str, Any]] = {
    "OP10": {
        "ip": "192.168.1.71", "port": 502, "unit_id": 1,
        "ranges": [
            ("M", 120, 151),  # M120..M270 includes M130/M260
            ("D", 0, 32),     # D0..D31 includes D16
            ("D", 390, 21),   # includes known D400/D404 counters
        ],
    },
    "OP20": {
        "ip": "192.168.1.76", "port": 502, "unit_id": 1,
        "ranges": [
            ("M", 200, 71),   # M200..M270 includes M207/M260
            ("D", 0, 32),     # D0..D31 includes D14
            ("D", 390, 21),   # includes known D400/D404 counters
        ],
    },
    "OP30": {
        "ip": "192.168.1.41", "port": 502, "unit_id": 1,
        "ranges": [
            ("M", 200, 91),   # M200..M290 includes M207/M280
            ("D", 0, 32),     # D0..D31 includes D14
            ("D", 390, 21),   # includes known D400/D404 counters
        ],
    },
    "OP40": {
        "ip": "192.168.1.46", "port": 502, "unit_id": 1,
        "ranges": [
            ("M", 200, 61),   # M200..M260 includes M207/M250
            ("D", 0, 32),     # D0..D31 includes D14
            ("D", 390, 21),   # bounded area around D400/D404
        ],
    },
    "OP50": {
        "ip": "192.168.1.51", "port": 502, "unit_id": 1,
        "ranges": [
            ("M", 70, 16),    # M70..M85 includes M77/M78
            ("M", 200, 51),   # M200..M250 includes M211/M241
            ("D", 0, 32),
            ("D", 390, 21),
        ],
    },
}

FIELDS = [
    "observed_at_utc", "observed_at_local", "sample_number",
    "module_name", "module_ip", "device", "value",
]


def explain_plan(module_name: str) -> None:
    plan = PLANS[module_name]
    print(f"{module_name} {plan['ip']}:{plan['port']} unit {plan['unit_id']}")
    for kind, start, quantity in plan["ranges"]:
        function = 1 if kind == "M" else 3
        address = 0x2000 + start if kind == "M" else start
        end = start + quantity - 1
        print(
            f"  FC{function:02d} {kind}{start}..{kind}{end} "
            f"(MODBUS address {address}, quantity {quantity})"
        )
    print(f"  {len(plan['ranges'])} read requests/sample; no write functions.")


def read_one_sample(module_name: str, timeout: float) -> list[tuple[str, int]]:
    plan = PLANS[module_name]
    values: list[tuple[str, int]] = []
    with ModbusTcpClient(
        host=plan["ip"], port=int(plan["port"]),
        unit_id=int(plan["unit_id"]), timeout=timeout,
    ) as client:
        for kind, start, quantity in plan["ranges"]:
            if kind == "M":
                block = client.read_coils(0x2000 + start, quantity)
                values.extend(
                    (f"M{start + offset}", int(value))
                    for offset, value in enumerate(block)
                )
            elif kind == "D":
                block = client.read_holding_registers(start, quantity)
                values.extend(
                    (f"D{start + offset}", int(value))
                    for offset, value in enumerate(block)
                )
            else:
                raise CollectorError(f"Blocked unsupported range type: {kind}")
    return values


def capture(args: argparse.Namespace) -> int:
    if not args.confirm_read_only:
        raise SystemExit(
            "Refusing to start without --confirm-read-only. "
            "Stop the live dashboard collector first."
        )
    if not 1 <= args.minutes <= 30:
        raise SystemExit("--minutes must be between 1 and 30")
    if not 10 <= args.interval <= 60:
        raise SystemExit("--interval must be between 10 and 60 seconds")
    if not 0.5 <= args.timeout <= 3.0:
        raise SystemExit("--timeout must be between 0.5 and 3.0 seconds")

    output = args.output
    if output is None:
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output = DEFAULT_OUTPUT / f"{args.module.lower()}_{stamp}.csv"
    output = output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if output.exists():
        raise SystemExit(f"Output already exists; choose a fresh CSV name: {output}")

    explain_plan(args.module)
    print(f"Output: {output}")
    print(
        f"Capturing for at most {args.minutes} minute(s), every "
        f"{args.interval:.0f}s. Ctrl+C stops safely."
    )

    deadline = time.monotonic() + args.minutes * 60
    sample_number = 0
    consecutive_errors = 0
    try:
        with output.open("x", newline="", encoding="utf-8") as handle:
            writer = csv.DictWriter(handle, fieldnames=FIELDS)
            writer.writeheader()
            while time.monotonic() < deadline:
                started = time.monotonic()
                sample_number += 1
                try:
                    values = read_one_sample(args.module, args.timeout)
                    utc_stamp, local_stamp = iso_times()
                    plan = PLANS[args.module]
                    for device, value in values:
                        writer.writerow({
                            "observed_at_utc": utc_stamp,
                            "observed_at_local": local_stamp,
                            "sample_number": sample_number,
                            "module_name": args.module,
                            "module_ip": plan["ip"],
                            "device": device,
                            "value": value,
                        })
                    handle.flush()
                    consecutive_errors = 0
                    print(
                        f"{local_stamp}: sample {sample_number} saved "
                        f"({len(values)} values)"
                    )
                except (OSError, CollectorError) as error:
                    consecutive_errors += 1
                    print(f"sample {sample_number} failed: {error}", file=sys.stderr)
                    if consecutive_errors >= 3:
                        print(
                            "Stopped after three consecutive errors; no retry storm.",
                            file=sys.stderr,
                        )
                        return 2
                remaining = args.interval - (time.monotonic() - started)
                if remaining > 0:
                    time.sleep(min(remaining, max(0.0, deadline - time.monotonic())))
    except KeyboardInterrupt:
        print("Stopped safely.")
    print(f"Saved: {output}")
    return 0


def analyze(path: Path) -> int:
    path = path.expanduser().resolve()
    histories: dict[str, list[tuple[str, int]]] = defaultdict(list)
    with path.open(newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            histories[row["device"]].append(
                (row["observed_at_local"], int(row["value"]))
            )

    changed: list[tuple[int, str, list[tuple[str, int]]]] = []
    for device, history in histories.items():
        transitions = sum(
            history[index][1] != history[index - 1][1]
            for index in range(1, len(history))
        )
        if transitions:
            changed.append((transitions, device, history))
    changed.sort(key=lambda item: (-item[0], item[1]))

    print(f"File: {path}")
    print(f"Devices captured: {len(histories)}")
    print(f"Devices that changed: {len(changed)}")
    if not changed:
        print("No changes observed. Capture while known cycles/results occur.")
        return 0
    print("\nChanged candidates:")
    for transitions, device, history in changed:
        values = [value for _, value in history]
        print(
            f"  {device:>5} transitions={transitions:<3} "
            f"first={values[0]:<6} last={values[-1]:<6} "
            f"min={min(values):<6} max={max(values):<6}"
        )
    print(
        "\nChanges are correlations only. Confirm candidates against the HMI "
        "and a known OK/NG cycle before naming them."
    )
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    explain = commands.add_parser("explain", help="print exact read plan")
    explain.add_argument("--module", choices=sorted(PLANS), required=True)
    capture_parser = commands.add_parser("capture", help="capture bounded values")
    capture_parser.add_argument("--module", choices=sorted(PLANS), required=True)
    capture_parser.add_argument("--minutes", type=int, default=10)
    capture_parser.add_argument("--interval", type=float, default=10.0)
    capture_parser.add_argument("--timeout", type=float, default=2.0)
    capture_parser.add_argument("--output", type=Path)
    capture_parser.add_argument("--confirm-read-only", action="store_true")
    analyze_parser = commands.add_parser("analyze", help="rank changed devices")
    analyze_parser.add_argument("csv_file", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command == "explain":
        explain_plan(args.module)
        return 0
    if args.command == "capture":
        return capture(args)
    if args.command == "analyze":
        return analyze(args.csv_file)
    raise SystemExit("Unknown command")


if __name__ == "__main__":
    raise SystemExit(main())
