"""Offline checks before starting Line Pulse on a second PC."""

from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent
COLLECTOR = ROOT / "fx5-readonly-collector"
DASHBOARD = ROOT / "fx5-live-dashboard"


def main() -> int:
    if sys.version_info < (3, 10):
        print("Python 3.10 or newer is required.", file=sys.stderr)
        return 1
    required = (
        COLLECTOR / "fx5_collector.py",
        COLLECTOR / "modules.json",
        DASHBOARD / "server.py",
        DASHBOARD / "static" / "index.html",
    )
    missing = [path for path in required if not path.is_file()]
    if missing:
        print("Missing project files:", file=sys.stderr)
        for path in missing:
            print(f"  {path}", file=sys.stderr)
        return 1

    sys.path.insert(0, str(COLLECTOR))
    import fx5_collector

    try:
        config = fx5_collector.load_config(COLLECTOR / "modules.json")
        fx5_collector.validate_config(config)
        data_root = DASHBOARD / "data"
        data_root.mkdir(parents=True, exist_ok=True)
        probe = data_root / ".line_pulse_write_check"
        with probe.open("w", encoding="utf-8") as handle:
            handle.write("ok")
        probe.unlink()
    except (OSError, fx5_collector.CollectorError, ValueError) as error:
        print(f"Line Pulse setup failed: {error}", file=sys.stderr)
        return 1

    print(f"Python: {sys.version.split()[0]}")
    print(f"Project: {ROOT}")
    print(f"Readings will be saved to: {data_root}")
    print("Configuration and local write check passed. No PLC was contacted.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
