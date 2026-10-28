#!/usr/bin/env python3
"""Create a human or JSON report from the FX5 collector database."""

from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import date, datetime
from pathlib import Path
from typing import Any


def report_for_date(database_path: Path, local_date: str) -> dict[str, Any]:
    # Strict parsing prevents accidental SQL wildcard/date input.
    date.fromisoformat(local_date)
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    try:
        modules = [
            row[0]
            for row in connection.execute(
                """
                SELECT module_name FROM raw_samples
                UNION
                SELECT module_name FROM collection_errors
                ORDER BY module_name
                """
            )
        ]
        result: dict[str, Any] = {"date": local_date, "modules": []}
        for module in modules:
            latest = connection.execute(
                """
                SELECT observed_at_local, module_ip, cycle_start, cycle_complete,
                       cycle_time_raw, cycle_time_seconds, ok_total, ng_total,
                       mapping_status
                FROM raw_samples
                WHERE module_name = ? AND substr(observed_at_local, 1, 10) = ?
                ORDER BY observed_at_local DESC, id DESC LIMIT 1
                """,
                (module, local_date),
            ).fetchone()
            error_summary = connection.execute(
                """
                SELECT COUNT(*) AS error_count,
                       MAX(observed_at_local) AS latest_error_at,
                       MAX(module_ip) AS module_ip
                FROM collection_errors
                WHERE module_name = ? AND substr(observed_at_local, 1, 10) = ?
                """,
                (module, local_date),
            ).fetchone()
            if latest is None:
                if not error_summary["error_count"]:
                    continue
                result["modules"].append(
                    {
                        "module": module,
                        "ip": error_summary["module_ip"],
                        "collection_status": "no_successful_sample",
                        "last_observed_at": None,
                        "first_sample_at": None,
                        "last_sample_at": None,
                        "successful_sample_count": 0,
                        "cycle_start_now": None,
                        "cycle_complete_now": None,
                        "cycle_time_raw": None,
                        "cycle_time_seconds": None,
                        "current_ok_total": None,
                        "current_ng_total": None,
                        "observed_ok_increase": 0,
                        "observed_ng_increase": 0,
                        "counter_reset_events": 0,
                        "observed_completed_cycles": 0,
                        "baseline_count": 0,
                        "observed_work_seconds": 0,
                        "average_observed_cycle_seconds": None,
                        "collection_error_count": error_summary["error_count"],
                        "latest_collection_error_at": error_summary[
                            "latest_error_at"
                        ],
                        "mapping_status": None,
                    }
                )
                continue

            sample_coverage = connection.execute(
                """
                SELECT COUNT(*) AS sample_count,
                       MIN(observed_at_local) AS first_sample_at,
                       MAX(observed_at_local) AS last_sample_at
                FROM raw_samples
                WHERE module_name = ? AND substr(observed_at_local, 1, 10) = ?
                """,
                (module, local_date),
            ).fetchone()

            event_totals = connection.execute(
                """
                SELECT
                    COALESCE(SUM(CASE WHEN event_type = 'OK_COUNT_CHANGE'
                                      AND delta > 0 THEN delta ELSE 0 END), 0) AS ok_increase,
                    COALESCE(SUM(CASE WHEN event_type = 'NG_COUNT_CHANGE'
                                      AND delta > 0 THEN delta ELSE 0 END), 0) AS ng_increase,
                    COALESCE(SUM(CASE WHEN event_type = 'OK_COUNT_CHANGE'
                                      AND delta < 0 THEN 1 ELSE 0 END), 0) AS ok_resets,
                    COALESCE(SUM(CASE WHEN event_type = 'NG_COUNT_CHANGE'
                                      AND delta < 0 THEN 1 ELSE 0 END), 0) AS ng_resets,
                    COALESCE(SUM(CASE WHEN event_type = 'CYCLE_COMPLETE'
                                      THEN 1 ELSE 0 END), 0) AS completed_cycles,
                    COALESCE(SUM(CASE WHEN event_type = 'BASELINE_ESTABLISHED'
                                      THEN 1 ELSE 0 END), 0) AS baselines,
                    COALESCE(SUM(CASE WHEN event_type = 'CYCLE_COMPLETE'
                                      THEN observed_cycle_seconds ELSE 0 END), 0)
                        AS observed_work_seconds,
                    AVG(CASE WHEN event_type = 'CYCLE_COMPLETE'
                             THEN observed_cycle_seconds END) AS average_cycle_seconds
                FROM events
                WHERE module_name = ? AND substr(observed_at_local, 1, 10) = ?
                """,
                (module, local_date),
            ).fetchone()
            result["modules"].append(
                {
                    "module": module,
                    "ip": latest["module_ip"],
                    "collection_status": (
                        "success_with_errors"
                        if error_summary["error_count"]
                        else "success"
                    ),
                    "last_observed_at": latest["observed_at_local"],
                    "first_sample_at": sample_coverage["first_sample_at"],
                    "last_sample_at": sample_coverage["last_sample_at"],
                    "successful_sample_count": sample_coverage["sample_count"],
                    "cycle_start_now": bool(latest["cycle_start"]),
                    "cycle_complete_now": bool(latest["cycle_complete"]),
                    "cycle_time_raw": latest["cycle_time_raw"],
                    "cycle_time_seconds": latest["cycle_time_seconds"],
                    "current_ok_total": latest["ok_total"],
                    "current_ng_total": latest["ng_total"],
                    "observed_ok_increase": event_totals["ok_increase"],
                    "observed_ng_increase": event_totals["ng_increase"],
                    "counter_reset_events": event_totals["ok_resets"]
                    + event_totals["ng_resets"],
                    "observed_completed_cycles": event_totals["completed_cycles"],
                    "baseline_count": event_totals["baselines"],
                    "observed_work_seconds": round(
                        event_totals["observed_work_seconds"], 3
                    ),
                    "average_observed_cycle_seconds": (
                        round(event_totals["average_cycle_seconds"], 3)
                        if event_totals["average_cycle_seconds"] is not None
                        else None
                    ),
                    "collection_error_count": error_summary["error_count"],
                    "latest_collection_error_at": error_summary["latest_error_at"],
                    "mapping_status": latest["mapping_status"],
                }
            )
        return result
    finally:
        connection.close()


def print_human(report: dict[str, Any]) -> None:
    print(f"FX5 production evidence for {report['date']}")
    if not report["modules"]:
        print("No samples were recorded for this date.")
        return
    for module in report["modules"]:
        print(f"\n{module['module']} ({module['ip']})")
        if module["collection_status"] == "no_successful_sample":
            print("  Status: NO SUCCESSFUL SAMPLE")
            print(
                "  Collection errors on this date: "
                f"{module['collection_error_count']}"
            )
            print(
                "  Latest error time: "
                f"{module['latest_collection_error_at']}"
            )
            continue
        print(f"  Status: {module['collection_status']}")
        print(f"  Last observed: {module['last_observed_at']}")
        print(
            "  Collector evidence window: "
            f"{module['first_sample_at']} to {module['last_sample_at']} "
            f"({module['successful_sample_count']} successful samples)"
        )
        if (
            module["current_ok_total"] is None
            and module["current_ng_total"] is None
        ):
            print("  Current PLC totals: not mapped for this station")
        else:
            print(
                "  Current PLC totals: "
                f"OK={module['current_ok_total']} NG={module['current_ng_total']}"
            )
        print(
            "  Changes observed on this date: "
            f"OK +{module['observed_ok_increase']} "
            f"NG +{module['observed_ng_increase']}"
        )
        print(
            "  Completed cycles observed: "
            f"{module['observed_completed_cycles']}"
        )
        print(
            "  Machine work witnessed in completed cycles: "
            f"{module['observed_work_seconds']} seconds"
        )
        if module["baseline_count"] > 1:
            print(
                f"  Warning: {module['baseline_count']} baselines were established; "
                "collector restarts created observation gaps"
            )
        average = module["average_observed_cycle_seconds"]
        print(
            "  Average observed cycle: "
            + (f"{average} seconds" if average is not None else "not yet available")
        )
        if module["cycle_time_raw"] is None:
            print("  PLC cycle-time value: not mapped for this station")
        elif module["cycle_time_seconds"] is None:
            print(
                f"  PLC cycle-time value: {module['cycle_time_raw']} raw units "
                "(unit not validated)"
            )
        else:
            print(f"  PLC cycle-time value: {module['cycle_time_seconds']} seconds")
        if module["counter_reset_events"]:
            print(
                f"  Warning: {module['counter_reset_events']} counter reset/rollover "
                "event(s) observed"
            )
        print(
            "  Collection errors on this date: "
            f"{module['collection_error_count']}"
        )
        print(f"  Mapping: {module['mapping_status']}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=Path("data/fx5_data.sqlite3"))
    parser.add_argument(
        "--date",
        default=datetime.now().astimezone().date().isoformat(),
        help="Local date in YYYY-MM-DD format (default: today)",
    )
    parser.add_argument("--json", action="store_true")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not args.database.exists():
        print(f"Database not found: {args.database}")
        return 1
    report = report_for_date(args.database, args.date)
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print_human(report)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
