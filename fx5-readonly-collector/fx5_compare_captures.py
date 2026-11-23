#!/usr/bin/env python3
"""Compare two bounded-discovery CSV captures offline; never contacts a PLC."""

from __future__ import annotations

import argparse
import csv
from collections import defaultdict
from pathlib import Path


REQUIRED = {"observed_at_local", "sample_number", "module_name", "module_ip", "device", "value"}
FIELDS = [
    "device", "baseline_first", "baseline_last", "running_first", "running_last",
    "delta", "baseline_changes", "running_changes", "candidate",
    "baseline_last_at", "running_last_at",
]


def load_capture(path: Path) -> tuple[tuple[str, str], dict[str, list[tuple[str, int]]]]:
    histories: dict[str, list[tuple[str, int]]] = defaultdict(list)
    identity: tuple[str, str] | None = None
    with path.open(newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames or not REQUIRED.issubset(reader.fieldnames):
            raise ValueError(f"{path}: not a bounded-discovery CSV")
        for row in reader:
            current = (row["module_name"], row["module_ip"])
            if identity is None:
                identity = current
            elif current != identity:
                raise ValueError(f"{path}: mixed modules or IPs")
            try:
                value = int(row["value"])
                int(row["sample_number"])
            except ValueError as error:
                raise ValueError(f"{path}: invalid sample/value") from error
            histories[row["device"]].append((row["observed_at_local"], value))
    if identity is None:
        raise ValueError(f"{path}: no successful samples")
    return identity, histories


def compare(
    baseline: Path, running: Path, output: Path,
    hmi_before_ok: int | None = None, hmi_after_ok: int | None = None,
    hmi_before_ng: int | None = None, hmi_after_ng: int | None = None,
) -> list[dict[str, object]]:
    base_id, base = load_capture(baseline)
    run_id, active = load_capture(running)
    if base_id != run_id:
        raise ValueError(f"Capture mismatch: {base_id} versus {run_id}")
    if set(base) != set(active):
        raise ValueError("Device sets differ; capture the same address plan in both phases")
    common = set(base)

    hmi_ok_delta = None if hmi_before_ok is None else hmi_after_ok - hmi_before_ok
    hmi_ng_delta = None if hmi_before_ng is None else hmi_after_ng - hmi_before_ng
    rows: list[dict[str, object]] = []
    for device in sorted(common, key=lambda name: (name[0], int(name[1:]))):
        before, after = base[device], active[device]
        delta = after[-1][1] - before[-1][1]
        base_changes = sum(before[i][1] != before[i - 1][1] for i in range(1, len(before)))
        changes = sum(after[i][1] != after[i - 1][1] for i in range(1, len(after)))
        candidates = []
        if device.startswith("D") and delta > 0 and base_changes == 0:
            if hmi_ok_delta is not None and delta == hmi_ok_delta and after[-1][1] == hmi_after_ok:
                candidates.append("OK total+delta match")
            elif hmi_ok_delta is not None and delta == hmi_ok_delta:
                candidates.append("OK delta match only")
            if hmi_ng_delta is not None and delta == hmi_ng_delta and after[-1][1] == hmi_after_ng:
                candidates.append("NG total+delta match")
            elif hmi_ng_delta is not None and delta == hmi_ng_delta:
                candidates.append("NG delta match only")
        rows.append({
            "device": device,
            "baseline_first": before[0][1], "baseline_last": before[-1][1],
            "running_first": after[0][1], "running_last": after[-1][1],
            "delta": delta, "baseline_changes": base_changes,
            "running_changes": changes,
            "candidate": "; ".join(candidates),
            "baseline_last_at": before[-1][0], "running_last_at": after[-1][0],
        })
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("x", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(row for row in rows if row["delta"] != 0 or row["running_changes"] != 0)
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("baseline", type=Path)
    parser.add_argument("running", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--prompt-hmi", action="store_true", help="ask for four actual HMI totals")
    for name in ("hmi-before-ok", "hmi-after-ok", "hmi-before-ng", "hmi-after-ng"):
        parser.add_argument(f"--{name}", type=int)
    args = parser.parse_args()
    if args.prompt_hmi:
        if any(getattr(args, name) is not None for name in
               ("hmi_before_ok", "hmi_after_ok", "hmi_before_ng", "hmi_after_ng")):
            parser.error("Use --prompt-hmi or explicit HMI totals, not both")
        try:
            args.hmi_before_ok = int(input("HMI OK at end of stopped capture: "))
            args.hmi_after_ok = int(input("HMI OK at end of running capture: "))
            args.hmi_before_ng = int(input("HMI NG at end of stopped capture: "))
            args.hmi_after_ng = int(input("HMI NG at end of running capture: "))
        except ValueError:
            parser.error("HMI totals must be whole numbers")
    if (args.hmi_before_ok is None) != (args.hmi_after_ok is None):
        parser.error("Provide both --hmi-before-ok and --hmi-after-ok")
    if (args.hmi_before_ng is None) != (args.hmi_after_ng is None):
        parser.error("Provide both --hmi-before-ng and --hmi-after-ng")
    if args.hmi_before_ok is not None and args.hmi_after_ok < args.hmi_before_ok:
        parser.error("HMI OK count decreased; check reset/shift before comparing")
    if args.hmi_before_ng is not None and args.hmi_after_ng < args.hmi_before_ng:
        parser.error("HMI NG count decreased; check reset/shift before comparing")
    try:
        rows = compare(
            args.baseline, args.running, args.output,
            args.hmi_before_ok, args.hmi_after_ok,
            args.hmi_before_ng, args.hmi_after_ng,
        )
    except (OSError, ValueError) as error:
        parser.error(str(error))
    changed = [row for row in rows if row["delta"] != 0 or row["running_changes"] != 0]
    changed.sort(key=lambda row: (not bool(row["candidate"]), -abs(int(row["delta"])), str(row["device"])))
    print(f"Compared {len(rows)} common devices; {len(changed)} changed.")
    for row in changed:
        print(f"{row['device']:>5} {row['baseline_last']:>6} -> {row['running_last']:<6} "
              f"delta={row['delta']:<6} stopped/running changes="
              f"{row['baseline_changes']}/{row['running_changes']} "
              f"{row['candidate']}")
    print(f"Saved comparison: {args.output}")
    print("Candidate is not a confirmed mapping. Verify against another known OK and NG event.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
