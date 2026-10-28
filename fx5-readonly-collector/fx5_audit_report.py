#!/usr/bin/env python3
"""Generate an IT-facing provenance report from FX5 configuration and evidence."""

from __future__ import annotations

import argparse
import sqlite3
from pathlib import Path
from typing import Any

import fx5_collector as collector


def request_rows(module: dict[str, Any], signals: list[collector.ResolvedSignal]):
    by_location = {
        (signal.function, signal.address): signal.device for signal in signals
    }
    for transaction_id, (function, address, quantity) in enumerate(
        collector.planned_reads(signals), start=1
    ):
        request = collector.build_read_request_adu(
            transaction_id,
            int(module["unit_id"]),
            function,
            address,
            quantity,
        )
        yield {
            "function": f"FC{function:02d}",
            "address": address,
            "quantity": quantity,
            "source": by_location.get(
                (function, address), "grouped register block"
            ),
            "request_hex": request.hex(" "),
        }


def latest_evidence(
    database_path: Path | None, module_name: str
) -> dict[str, Any] | None:
    if database_path is None or not database_path.exists():
        return None
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    try:
        sample = connection.execute(
            """
            SELECT id, observed_at_utc, observed_at_local, module_ip,
                   cycle_start, cycle_complete, cycle_time_raw,
                   cycle_time_seconds, ok_total, ng_total, mapping_status
            FROM raw_samples
            WHERE module_name = ?
            ORDER BY id DESC LIMIT 1
            """,
            (module_name,),
        ).fetchone()
        if sample is None:
            return None
        frames = [
            dict(row)
            for row in connection.execute(
                """
                SELECT function, address, quantity, request_adu_hex,
                       response_adu_hex
                FROM protocol_frames
                WHERE sample_id = ?
                ORDER BY id
                """,
                (sample["id"],),
            )
        ]
        return {"sample": dict(sample), "frames": frames}
    finally:
        connection.close()


def build_report(
    config: dict[str, Any], database_path: Path | None = None
) -> str:
    collector.validate_config(config)
    lines = [
        "# Mitsubishi FX5 read-only collection audit",
        "",
        "## Provenance statement",
        "",
        "The Ubuntu laptop opens TCP port 502 and sends binary MODBUS/TCP read "
        "requests. The PLC returns bits and 16-bit register words. Business "
        "labels such as cycle time, OK, and NG come from the selected signal "
        "profile—not from text inside the PLC response.",
        "",
        "Permitted functions: FC01, FC02, FC03, FC04 (read-only).",
        "",
        "No discovery scan and no write function are implemented.",
        "",
        "## Configured modules",
        "",
        "| Module | Endpoint | Enabled | Signal profile | Evidence state |",
        "|---|---|---:|---|---|",
    ]
    for module in config["modules"]:
        profile_name = module.get("signal_profile")
        evidence = latest_evidence(database_path, module["name"])
        evidence_state = (
            f"latest sample {evidence['sample']['observed_at_local']}"
            if evidence
            else "no stored sample"
        )
        lines.append(
            f"| {module['name']} | {module['ip']}:{module['port']} "
            f"(unit {module['unit_id']}) | "
            f"{'yes' if module.get('enabled') else 'no'} | "
            f"{profile_name or 'NOT ASSIGNED'} | {evidence_state} |"
        )

    for module in config["modules"]:
        if not module.get("signal_profile"):
            continue
        signals = collector.signals_for_module(config, module)
        lines.extend(
            [
                "",
                f"## {module['name']} — {module['signal_profile']}",
                "",
                "### Signal translation",
                "",
                "| Meaning | PLC device | Function | MODBUS address | Data type | Word order | Status |",
                "|---|---|---:|---:|---|---|---|",
            ]
        )
        for signal in signals:
            lines.append(
                f"| {signal.name} | {signal.device} | FC{signal.function:02d} "
                f"| {signal.address} | {signal.data_type} | "
                f"{signal.word_order if signal.function == 3 else 'n/a'} | "
                f"{signal.source_status} |"
            )
        lines.extend(
            [
                "",
                "### Exact request plan",
                "",
                "| Function | Address | Quantity | Device/source | Request ADU (hex) |",
                "|---|---:|---:|---|---|",
            ]
        )
        for row in request_rows(module, signals):
            lines.append(
                f"| {row['function']} | {row['address']} | {row['quantity']} "
                f"| {row['source']} | `{row['request_hex']}` |"
            )

        evidence = latest_evidence(database_path, module["name"])
        lines.extend(["", "### Latest stored evidence", ""])
        if evidence is None:
            lines.append(
                "No successful sample is stored. Configuration alone does not "
                "prove PLC connectivity or signal meaning."
            )
            continue
        sample = evidence["sample"]
        lines.extend(
            [
                f"- Sample ID: {sample['id']}",
                f"- Observed locally: {sample['observed_at_local']}",
                f"- Endpoint: {sample['module_ip']}:{module['port']}",
                f"- Cycle start / complete: {sample['cycle_start']} / "
                f"{sample['cycle_complete']}",
                f"- Cycle time: {sample['cycle_time_raw']} raw units",
                f"- Current cumulative totals: OK={sample['ok_total']}, "
                f"NG={sample['ng_total']}",
                f"- Mapping status: {sample['mapping_status']}",
                "",
                "| FC | Address | Qty | Request ADU | Response ADU |",
                "|---:|---:|---:|---|---|",
            ]
        )
        for frame in evidence["frames"]:
            lines.append(
                f"| {frame['function']} | {frame['address']} | "
                f"{frame['quantity']} | `{frame['request_adu_hex']}` | "
                f"`{frame['response_adu_hex']}` |"
            )

    lines.extend(
        [
            "",
            "## Interpretation limits",
            "",
            "- A successful response proves transport and raw bytes only.",
            "- Candidate mappings require GX Works3/HMI or controlled-cycle validation.",
            "- Current counter values do not reveal when earlier parts were produced.",
            "- Production by date is defensible only from counter changes observed "
            "while this collector was running.",
            "",
        ]
    )
    return "\n".join(lines)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("modules.json"))
    parser.add_argument("--database", type=Path)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        config = collector.load_config(args.config)
        report = build_report(config, args.database)
    except (collector.CollectorError, sqlite3.Error) as error:
        print(f"Cannot create audit report: {error}")
        return 1
    if args.output:
        args.output.write_text(report, encoding="utf-8")
        print(f"Audit report written to {args.output}")
    else:
        print(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
