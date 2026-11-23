#!/usr/bin/env python3
"""Local read-only live dashboard for the Mitsubishi FX5 production line."""

from __future__ import annotations

import argparse
import csv
import json
import mimetypes
import signal
import socket
import sys
import threading
import time
from collections import deque
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


HERE = Path(__file__).resolve().parent
COLLECTOR_ROOT = HERE.parent / "fx5-readonly-collector"
sys.path.insert(0, str(COLLECTOR_ROOT))

import fx5_collector as collector  # noqa: E402


CONFIG_PATH = COLLECTOR_ROOT / "modules.json"
STATIC_ROOT = HERE / "static"
DATA_ROOT = HERE / "data"
MODULE_CSV_FIELDS = [*collector.RAW_FIELDS, "raw_json"]


def save_module_reading(
    data_root: Path, row: dict[str, Any], raw_values: dict[str, Any]
) -> Path:
    """Append one complete dashboard reading to its station's local CSV."""
    module_name = row["module_name"]
    if module_name not in {"OP10", "OP20", "OP30", "OP40", "OP50A", "OP50B"}:
        raise ValueError(f"Unexpected module name: {module_name}")
    path = data_root / "modules" / f"{module_name.lower()}.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    collector.append_csv(
        path, MODULE_CSV_FIELDS,
        {**row, "raw_json": json.dumps(raw_values, sort_keys=True)},
    )
    return path


def load_saved_readings(
    raw_csv: Path, discovery_root: Path,
) -> dict[str, dict[str, Any]]:
    """Find the newest saved D400/D404 pair per OP10–OP40, without PLC I/O."""
    names = {"OP10", "OP20", "OP30", "OP40"}
    latest: dict[str, dict[str, Any]] = {}

    def consider(
        name: str, ip: str, observed_at: str, ok: str, ng: str, source: str,
    ) -> None:
        if name not in names:
            return
        try:
            stamp = datetime.fromisoformat(observed_at)
            ok_total, ng_total = int(ok), int(ng)
        except (TypeError, ValueError):
            return
        if ok_total < 0 or ng_total < 0:
            return
        previous = latest.get(name)
        if previous is not None and stamp <= datetime.fromisoformat(
            previous["last_observed_at"]
        ):
            return
        latest[name] = {
            "module_name": name,
            "module_ip": ip,
            "ok_total": ok_total,
            "ng_total": ng_total,
            "last_observed_at": observed_at,
            "saved_source": source,
        }

    if raw_csv.is_file():
        with raw_csv.open(newline="", encoding="utf-8") as handle:
            for row in csv.DictReader(handle):
                consider(
                    row.get("module_name", ""), row.get("module_ip", ""),
                    row.get("observed_at_local", ""), row.get("ok_total", ""),
                    row.get("ng_total", ""), f"dashboard/{raw_csv.name}",
                )

    if discovery_root.is_dir():
        for path in sorted(discovery_root.glob("op[1-4]0_*.csv")):
            samples: dict[tuple[str, str, str], dict[str, str]] = {}
            with path.open(newline="", encoding="utf-8") as handle:
                for row in csv.DictReader(handle):
                    name = row.get("module_name", "")
                    device = row.get("device")
                    if name not in names or device not in {"D400", "D404"}:
                        continue
                    key = (
                        name, row.get("module_ip", ""),
                        row.get("observed_at_local", ""),
                    )
                    samples.setdefault(key, {})[device] = row.get("value", "")
            for (name, ip, observed_at), values in samples.items():
                if "D400" in values and "D404" in values:
                    consider(
                        name, ip, observed_at, values["D400"], values["D404"],
                        f"discovery/{path.name}",
                    )
    return latest


class DashboardRuntime:
    def __init__(self) -> None:
        self.config = collector.load_config(CONFIG_PATH)
        collector.validate_config(self.config)
        self.modules = [m for m in self.config["modules"] if m.get("enabled")]
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.worker: threading.Thread | None = None
        self.running = False
        self.started_at: str | None = None
        self.connection_status: dict[str, dict[str, Any]] = {}
        self.saved_readings = load_saved_readings(
            DATA_ROOT / "raw_samples.csv", COLLECTOR_ROOT / "discovery_data"
        )
        self.latest: dict[str, dict[str, Any]] = {
            module["name"]: {
                "module_name": module["name"],
                "module_ip": module["ip"],
                "status": "waiting",
                "cycle_start": None,
                "cycle_complete": None,
                "cycle_time_raw": None,
                "cycle_time_seconds": None,
                "ok_total": None,
                "ng_total": None,
                "last_observed_at": None,
                "last_error": None,
            }
            for module in self.modules
        }
        for name, saved in self.saved_readings.items():
            if name in self.latest:
                self.latest[name].update(saved)
                self.latest[name]["status"] = "saved"
        self.recent_events: deque[dict[str, Any]] = deque(maxlen=80)
        self.successful_samples = 0
        self.error_count = 0

    def _unique_endpoints(self) -> list[tuple[str, int]]:
        return sorted({(m["ip"], int(m["port"])) for m in self.modules})

    def check_connections(self) -> dict[str, Any]:
        checked: dict[str, dict[str, Any]] = {}
        timeout = float(self.config["socket_timeout_seconds"])
        for host, port in self._unique_endpoints():
            started = time.monotonic()
            try:
                with socket.create_connection((host, port), timeout=timeout):
                    pass
                checked[host] = {
                    "ip": host,
                    "port": port,
                    "online": True,
                    "latency_ms": round((time.monotonic() - started) * 1000, 1),
                    "error": None,
                }
            except OSError as error:
                checked[host] = {
                    "ip": host,
                    "port": port,
                    "online": False,
                    "latency_ms": None,
                    "error": str(error),
                }
        with self.lock:
            self.connection_status = checked
        return self.snapshot()

    def all_plcs_online(self) -> bool:
        with self.lock:
            statuses = list(self.connection_status.values())
        return bool(statuses) and all(item["online"] for item in statuses)

    def start(self) -> tuple[bool, str]:
        self.check_connections()
        with self.lock:
            any_online = any(
                item["online"] for item in self.connection_status.values()
            )
        if not any_online:
            return False, "No PLC endpoint is online. Check Ethernet and try again."
        with self.lock:
            if self.running:
                return True, "Collection is already running."
            self.running = True
            self.started_at = collector.iso_times()[1]
            self.stop_event.clear()
            self.worker = threading.Thread(
                target=self._collection_loop,
                name="fx5-dashboard-collector",
                daemon=True,
            )
            self.worker.start()
        return True, "Read-only collection started. Each module saves to its own CSV."

    def stop(self) -> str:
        self.stop_event.set()
        worker = self.worker
        if worker and worker.is_alive():
            worker.join(timeout=5)
        with self.lock:
            self.running = False
        return "Collection stopped safely."

    def _collection_loop(self) -> None:
        DATA_ROOT.mkdir(parents=True, exist_ok=True)
        database = collector.initialize_database(DATA_ROOT / "fx5_data.sqlite3")
        raw_csv = DATA_ROOT / "raw_samples.csv"
        events_csv = DATA_ROOT / "events.csv"
        errors_csv = DATA_ROOT / "collection_errors.csv"
        states = {module["name"]: collector.RuntimeState() for module in self.modules}
        timeout = float(self.config["socket_timeout_seconds"])
        interval = float(self.config["poll_interval_seconds"])
        try:
            while not self.stop_event.is_set():
                loop_started = time.monotonic()
                for module in self.modules:
                    if self.stop_event.is_set():
                        break
                    try:
                        signals = collector.signals_for_module(self.config, module)
                        profile = self.config["signal_profiles"][
                            module["signal_profile"]
                        ]
                        frames: list[collector.ProtocolFrame] = []
                        values = collector.read_snapshot(
                            module,
                            signals,
                            timeout,
                            capture_frames=frames,
                        )
                        observed_at_utc, observed_at_local = collector.iso_times()
                        cycle_time_raw = values.get("cycle_time")
                        scale = profile.get("cycle_time_scale_seconds")
                        cycle_time_seconds = (
                            float(cycle_time_raw) * float(scale)
                            if scale is not None and cycle_time_raw is not None
                            else None
                        )
                        row = {
                            "observed_at_utc": observed_at_utc,
                            "observed_at_local": observed_at_local,
                            "module_name": module["name"],
                            "module_ip": module["ip"],
                            "cycle_start": int(values["cycle_start"]),
                            "cycle_complete": int(values["cycle_complete"]),
                            "cycle_time_raw": (
                                int(cycle_time_raw)
                                if cycle_time_raw is not None
                                else None
                            ),
                            "cycle_time_seconds": cycle_time_seconds,
                            "ok_total": (
                                int(values["ok_total"])
                                if "ok_total" in values
                                else None
                            ),
                            "ng_total": (
                                int(values["ng_total"])
                                if "ng_total" in values
                                else None
                            ),
                            "mapping_status": (
                                f"{module['signal_profile']}:unverified"
                            ),
                        }
                        sample_id = collector.store_raw(
                            database, raw_csv, row, values
                        )
                        save_module_reading(DATA_ROOT, row, values)
                        collector.store_protocol_frames(
                            database, sample_id, module["name"], frames
                        )
                        # OP50 M241 is a cylinder-down signal in the ladder,
                        # not a verified cycle boundary. Keep its raw bits but
                        # do not turn provisional OP50 mappings into cycles.
                        events = (
                            []
                            if module["name"].startswith("OP50")
                            else collector.derive_events(
                                module["name"],
                                values,
                                states[module["name"]],
                                observed_at_utc,
                                observed_at_local,
                            )
                        )
                        for event in events:
                            collector.store_event(database, events_csv, event)
                        with self.lock:
                            self.successful_samples += 1
                            self.latest[module["name"]] = {
                                **row,
                                "status": "live",
                                "saved_source": None,
                                "last_observed_at": observed_at_local,
                                "last_error": None,
                            }
                            for event in events:
                                self.recent_events.appendleft(event)
                    except (OSError, collector.CollectorError) as error:
                        error_row = collector.store_collection_error(
                            database, errors_csv, module, error
                        )
                        with self.lock:
                            self.error_count += 1
                            previous = self.latest[module["name"]]
                            self.latest[module["name"]] = {
                                **previous,
                                "status": "degraded",
                                "last_error": str(error),
                                "last_error_at": error_row["observed_at_local"],
                            }
                elapsed = time.monotonic() - loop_started
                self.stop_event.wait(max(0.0, interval - elapsed))
        finally:
            database.close()
            with self.lock:
                self.running = False

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            connections = list(self.connection_status.values())
            online_count = sum(1 for item in connections if item["online"])
            modules = []
            for module in self.latest.values():
                visible = dict(module)
                if not self.running and visible["last_observed_at"]:
                    visible["status"] = "saved"
                modules.append(visible)
            return {
                "running": self.running,
                "started_at": self.started_at,
                "plcs_online": online_count,
                "plcs_total": len(self._unique_endpoints()),
                "all_online": bool(connections)
                and online_count == len(self._unique_endpoints()),
                "connections": connections,
                "modules": modules,
                "events": list(self.recent_events),
                "successful_samples": self.successful_samples,
                "error_count": self.error_count,
                "poll_interval_seconds": self.config["poll_interval_seconds"],
                "read_only": True,
            }


RUNTIME = DashboardRuntime()


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "FX5Dashboard/1.0"

    def log_message(self, format: str, *args: object) -> None:
        sys.stderr.write("[dashboard] " + format % args + "\n")

    def _json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _file(self, path: Path, *, attachment: bool = False) -> None:
        if not path.exists() or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        body = path.read_bytes()
        content_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if attachment:
            self.send_header(
                "Content-Disposition", f'attachment; filename="{path.name}"'
            )
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/state":
            self._json(RUNTIME.snapshot())
            return
        if path == "/api/export/raw":
            self._file(DATA_ROOT / "raw_samples.csv", attachment=True)
            return
        if path == "/api/export/events":
            self._file(DATA_ROOT / "events.csv", attachment=True)
            return
        if path in {"/", "/index.html"}:
            self._file(STATIC_ROOT / "index.html")
            return
        candidate = (STATIC_ROOT / path.lstrip("/")).resolve()
        if STATIC_ROOT.resolve() not in candidate.parents:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        self._file(candidate)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/check":
            self._json(RUNTIME.check_connections())
            return
        if path == "/api/start":
            ok, message = RUNTIME.start()
            self._json(
                {"ok": ok, "message": message, "state": RUNTIME.snapshot()},
                HTTPStatus.OK if ok else HTTPStatus.CONFLICT,
            )
            return
        if path == "/api/stop":
            message = RUNTIME.stop()
            self._json({"ok": True, "message": message, "state": RUNTIME.snapshot()})
            return
        self.send_error(HTTPStatus.NOT_FOUND)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    server = ThreadingHTTPServer((args.host, args.port), DashboardHandler)

    def shutdown_handler(_signum: int, _frame: object) -> None:
        RUNTIME.stop_event.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, shutdown_handler)
    signal.signal(signal.SIGTERM, shutdown_handler)
    print(f"FX5 dashboard: http://{args.host}:{args.port}")
    print("Read-only mode. Press Ctrl+C to stop the dashboard.")
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        RUNTIME.stop()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
