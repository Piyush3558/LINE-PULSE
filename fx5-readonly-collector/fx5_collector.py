#!/usr/bin/env python3
"""Low-rate, read-only MODBUS/TCP collector for Mitsubishi FX5 PLCs."""

from __future__ import annotations

import argparse
import csv
import ipaddress
import json
import socket
import sqlite3
import struct
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


READ_ONLY_FUNCTIONS = frozenset({1, 2, 3, 4})
MAX_HOLDING_REGISTERS = 125
MAX_COILS = 2000


class CollectorError(RuntimeError):
    pass


class ModbusException(CollectorError):
    def __init__(self, function: int, code: int) -> None:
        super().__init__(f"MODBUS exception {code} for function {function}")
        self.function = function
        self.code = code


@dataclass(frozen=True)
class ResolvedSignal:
    name: str
    device: str
    function: int
    address: int
    source_status: str
    data_type: str
    word_order: str


@dataclass(frozen=True)
class ProtocolFrame:
    """Exact read-only MODBUS request/response evidence for one read."""

    transaction_id: int
    function: int
    address: int
    quantity: int
    request_adu_hex: str
    response_adu_hex: str


@dataclass
class RuntimeState:
    previous: dict[str, Any] | None = None
    active_started_monotonic: float | None = None
    active_started_utc: str | None = None


def build_read_request_adu(
    transaction_id: int,
    unit_id: int,
    function: int,
    address: int,
    quantity: int,
) -> bytes:
    """Build one MODBUS/TCP read request; write functions are impossible here."""
    if function not in READ_ONLY_FUNCTIONS:
        raise CollectorError(
            f"Blocked unsafe MODBUS function {function}; reads only"
        )
    if not 0 <= transaction_id <= 0xFFFF:
        raise CollectorError("Transaction ID is outside the MODBUS range")
    if not 0 <= unit_id <= 0xFF:
        raise CollectorError("Unit ID is outside the MODBUS range")
    if not 0 <= address <= 0xFFFF:
        raise CollectorError(f"Address out of range: {address}")
    if not 1 <= quantity <= 0xFFFF:
        raise CollectorError(f"Invalid read quantity: {quantity}")
    pdu = struct.pack(">BHH", function, address, quantity)
    return struct.pack(">HHHB", transaction_id, 0, len(pdu) + 1, unit_id) + pdu


@dataclass
class ModbusTcpClient:
    host: str
    port: int
    unit_id: int
    timeout: float
    _transaction_id: int = field(default=0, init=False)
    _socket: socket.socket | None = field(default=None, init=False)
    frames: list[ProtocolFrame] = field(default_factory=list, init=False)

    def __enter__(self) -> "ModbusTcpClient":
        self._socket = socket.create_connection(
            (self.host, self.port), timeout=self.timeout
        )
        self._socket.settimeout(self.timeout)
        return self

    def __exit__(self, *_: object) -> None:
        if self._socket is not None:
            self._socket.close()
            self._socket = None

    def _receive_exact(self, length: int) -> bytes:
        if self._socket is None:
            raise CollectorError("MODBUS socket is not connected")
        data = bytearray()
        while len(data) < length:
            chunk = self._socket.recv(length - len(data))
            if not chunk:
                raise CollectorError("PLC closed the connection")
            data.extend(chunk)
        return bytes(data)

    def _request(self, function: int, address: int, quantity: int) -> bytes:
        if self._socket is None:
            # Still validate the requested function first, so an unsafe call is
            # blocked independently of connection state.
            if function not in READ_ONLY_FUNCTIONS:
                raise CollectorError(
                    f"Blocked unsafe MODBUS function {function}; reads only"
                )
            raise CollectorError("MODBUS socket is not connected")

        self._transaction_id = (self._transaction_id % 0xFFFF) + 1
        request = build_read_request_adu(
            self._transaction_id,
            self.unit_id,
            function,
            address,
            quantity,
        )
        self._socket.sendall(request)

        header = self._receive_exact(7)
        response_id, protocol_id, length, unit_id = struct.unpack(">HHHB", header)
        if length < 2 or length > 260:
            raise CollectorError(f"Invalid MODBUS response length: {length}")
        response_pdu = self._receive_exact(length - 1)
        response_adu = header + response_pdu

        if response_id != self._transaction_id:
            raise CollectorError("MODBUS transaction ID mismatch")
        if protocol_id != 0:
            raise CollectorError("Invalid MODBUS protocol ID")
        if unit_id != self.unit_id:
            raise CollectorError("MODBUS unit ID mismatch")
        if response_pdu[0] & 0x80:
            if len(response_pdu) < 2:
                raise CollectorError("Incomplete MODBUS exception response")
            raise ModbusException(function, response_pdu[1])
        if response_pdu[0] != function:
            raise CollectorError("Unexpected MODBUS function in response")
        self.frames.append(
            ProtocolFrame(
                transaction_id=self._transaction_id,
                function=function,
                address=address,
                quantity=quantity,
                request_adu_hex=request.hex(" "),
                response_adu_hex=response_adu.hex(" "),
            )
        )
        return response_pdu

    def read_coils(self, address: int, quantity: int) -> list[bool]:
        if not 1 <= quantity <= MAX_COILS:
            raise CollectorError("Coil quantity is outside safe protocol limits")
        response = self._request(1, address, quantity)
        expected_bytes = (quantity + 7) // 8
        if len(response) != 2 + expected_bytes or response[1] != expected_bytes:
            raise CollectorError("Unexpected coil response byte count")
        return [
            bool(response[2 + (index // 8)] & (1 << (index % 8)))
            for index in range(quantity)
        ]

    def read_holding_registers(self, address: int, quantity: int) -> list[int]:
        if not 1 <= quantity <= MAX_HOLDING_REGISTERS:
            raise CollectorError("Register quantity is outside safe protocol limits")
        response = self._request(3, address, quantity)
        expected_bytes = quantity * 2
        if len(response) != 2 + expected_bytes or response[1] != expected_bytes:
            raise CollectorError("Unexpected register response byte count")
        return list(struct.unpack(">" + "H" * quantity, response[2:]))


def resolve_device(device: str, profile: str) -> tuple[int, int]:
    normalized = device.strip().upper()
    if profile != "fx5_dedicated_default":
        raise CollectorError(f"Unsupported mapping profile: {profile}")
    if len(normalized) < 2 or not normalized[1:].isdigit():
        raise CollectorError(f"Unsupported device syntax: {device}")
    number = int(normalized[1:])
    if normalized.startswith("M"):
        if not 0 <= number <= 7679:
            raise CollectorError(f"M device outside FX5 default range: {device}")
        return 1, 0x2000 + number
    if normalized.startswith("D"):
        if not 0 <= number <= 7999:
            raise CollectorError(f"D device outside FX5 default range: {device}")
        return 3, number
    raise CollectorError(f"Only M and D devices are supported initially: {device}")


def resolve_signals(
    mapping_profile: str, definitions: dict[str, Any]
) -> list[ResolvedSignal]:
    result: list[ResolvedSignal] = []
    for name, definition in definitions.items():
        device = definition["device"]
        function, address = resolve_device(device, mapping_profile)
        default_type = "bool" if function in (1, 2) else "uint16"
        data_type = definition.get("data_type", default_type)
        allowed_types = {"bool"} if function in (1, 2) else {
            "uint16", "int16", "uint32", "int32"
        }
        if data_type not in allowed_types:
            raise CollectorError(
                f"Invalid data_type {data_type} for signal {name}"
            )
        word_order = definition.get("word_order", "high_word_first")
        if word_order not in {"high_word_first", "low_word_first"}:
            raise CollectorError(f"Invalid word_order for signal {name}")
        result.append(
            ResolvedSignal(
                name=name,
                device=device.upper(),
                function=function,
                address=address,
                source_status=definition.get("source_status", "unverified"),
                data_type=data_type,
                word_order=word_order,
            )
        )
    return result


def signals_for_module(
    config: dict[str, Any], module: dict[str, Any]
) -> list[ResolvedSignal]:
    profile_name = module.get("signal_profile")
    profiles = config.get("signal_profiles", {})
    if not profile_name or profile_name not in profiles:
        raise CollectorError(
            f"Module {module.get('name', '<unnamed>')} has no valid signal_profile"
        )
    profile = profiles[profile_name]
    return resolve_signals(profile["mapping_profile"], profile["signals"])


def grouped_ranges(
    addresses: Iterable[int], *, max_gap: int, max_span: int
) -> list[tuple[int, int]]:
    ordered = sorted(set(addresses))
    if not ordered:
        return []
    groups: list[tuple[int, int]] = []
    start = previous = ordered[0]
    for address in ordered[1:]:
        proposed_span = address - start + 1
        if address - previous <= max_gap + 1 and proposed_span <= max_span:
            previous = address
            continue
        groups.append((start, previous - start + 1))
        start = previous = address
    groups.append((start, previous - start + 1))
    return groups


def planned_reads(signals: list[ResolvedSignal]) -> list[tuple[int, int, int]]:
    """Return the exact low-rate requests used for one module snapshot."""
    result: list[tuple[int, int, int]] = []
    for signal in signals:
        if signal.function == 1:
            result.append((1, signal.address, 1))
    register_addresses: set[int] = set()
    for signal in signals:
        if signal.function == 3:
            register_addresses.update(
                range(signal.address, signal.address + register_word_count(signal))
            )
    for start, quantity in grouped_ranges(
        register_addresses, max_gap=4, max_span=MAX_HOLDING_REGISTERS
    ):
        result.append((3, start, quantity))
    return result


def register_word_count(signal: ResolvedSignal) -> int:
    if signal.data_type in {"uint16", "int16"}:
        return 1
    if signal.data_type in {"uint32", "int32"}:
        return 2
    raise CollectorError(
        f"Signal {signal.name} is not a supported register data type"
    )


def decode_register_value(signal: ResolvedSignal, words: list[int]) -> int:
    expected = register_word_count(signal)
    if len(words) != expected:
        raise CollectorError(
            f"Signal {signal.name} expected {expected} register word(s)"
        )
    if expected == 1:
        value = words[0]
        if signal.data_type == "int16" and value >= 0x8000:
            value -= 0x10000
        return value
    ordered = words if signal.word_order == "high_word_first" else list(reversed(words))
    value = (ordered[0] << 16) | ordered[1]
    if signal.data_type == "int32" and value >= 0x80000000:
        value -= 0x100000000
    return value


def explain_requests(config: dict[str, Any]) -> None:
    print("Exact MODBUS/TCP request plans by named signal profile:")
    for profile_name, profile in config["signal_profiles"].items():
        signals = resolve_signals(
            profile["mapping_profile"], profile["signals"]
        )
        modules = [
            module for module in config["modules"]
            if module.get("signal_profile") == profile_name
        ]
        unit_id = int(modules[0].get("unit_id", 1)) if modules else 1
        by_location = {
            (signal.function, signal.address): signal.device for signal in signals
        }
        module_names = ", ".join(module["name"] for module in modules) or "unused"
        print(f"\nProfile {profile_name} (modules: {module_names})")
        for transaction_id, (function, address, quantity) in enumerate(
            planned_reads(signals), start=1
        ):
            adu = build_read_request_adu(
                transaction_id, unit_id, function, address, quantity
            )
            device = by_location.get(
                (function, address), "grouped register block"
            )
            print(
                f"  {transaction_id}. FC{function:02d} address={address} "
                f"quantity={quantity} source={device}"
            )
            print(f"     {adu.hex(' ')}")
    print("No request above contains a MODBUS write function.")


def validate_config(config: dict[str, Any]) -> list[ResolvedSignal]:
    required = {
        "poll_interval_seconds", "socket_timeout_seconds", "modules",
        "signal_profiles",
    }
    missing = sorted(required - config.keys())
    if missing:
        raise CollectorError(f"Missing configuration keys: {', '.join(missing)}")
    if not 2.0 <= float(config["poll_interval_seconds"]) <= 3600:
        raise CollectorError("poll_interval_seconds must be between 2 and 3600")
    if not 0.25 <= float(config["socket_timeout_seconds"]) <= 10:
        raise CollectorError("socket_timeout_seconds must be between 0.25 and 10")
    if not 1 <= len(config["modules"]) <= 20:
        raise CollectorError("Configure between 1 and 20 modules")

    if not isinstance(config["signal_profiles"], dict) or not config["signal_profiles"]:
        raise CollectorError("At least one named signal profile is required")
    resolved_profiles: dict[str, list[ResolvedSignal]] = {}
    for profile_name, profile in config["signal_profiles"].items():
        try:
            resolved_profiles[profile_name] = resolve_signals(
                profile["mapping_profile"], profile["signals"]
            )
        except KeyError as error:
            raise CollectorError(
                f"Signal profile {profile_name} is incomplete"
            ) from error
        scale = profile.get("cycle_time_scale_seconds")
        if scale is not None and float(scale) <= 0:
            raise CollectorError(
                f"Signal profile {profile_name} has an invalid cycle-time scale"
            )
        for signal in resolved_profiles[profile_name]:
            if (
                signal.function == 3
                and signal.address + register_word_count(signal) - 1 > 7999
            ):
                raise CollectorError(
                    f"Signal {signal.name} extends beyond the FX5 D range"
                )

    names: set[str] = set()
    for module in config["modules"]:
        name = str(module.get("name", "")).strip()
        if not name or name in names:
            raise CollectorError("Every module needs a unique non-empty name")
        names.add(name)
        port = int(module.get("port", 0))
        unit_id = int(module.get("unit_id", -1))
        if not 1 <= port <= 65535:
            raise CollectorError(f"Invalid port for {name}")
        if not 0 <= unit_id <= 255:
            raise CollectorError(f"Invalid unit_id for {name}")
        if module.get("enabled"):
            try:
                ipaddress.ip_address(module["ip"])
            except (KeyError, ValueError) as error:
                raise CollectorError(f"Invalid enabled IP for {name}") from error
            if module.get("signal_profile") not in resolved_profiles:
                raise CollectorError(
                    f"Enabled module {name} needs an explicit valid signal_profile"
                )

    # Every logical station needs cycle boundaries. Cycle time and counters are
    # optional because some stations expose only their start/finish bits.
    required_signals = {"cycle_start", "cycle_complete"}
    for profile_name, signals in resolved_profiles.items():
        actual = {signal.name for signal in signals}
        missing_signals = sorted(required_signals - actual)
        if missing_signals:
            raise CollectorError(
                f"Signal profile {profile_name} is missing: "
                f"{', '.join(missing_signals)}"
            )
    return next(iter(resolved_profiles.values()))


def read_snapshot(
    module: dict[str, Any],
    signals: list[ResolvedSignal],
    timeout: float,
    *,
    capture_frames: list[ProtocolFrame] | None = None,
) -> dict[str, Any]:
    values: dict[str, Any] = {}
    with ModbusTcpClient(
        host=module["ip"],
        port=int(module["port"]),
        unit_id=int(module["unit_id"]),
        timeout=timeout,
    ) as client:
        coils = [signal for signal in signals if signal.function == 1]
        registers = [signal for signal in signals if signal.function == 3]

        # Bits are intentionally read one at a time. This avoids reading the
        # unrelated 130-bit span between M130 and M260.
        for signal in coils:
            values[signal.name] = client.read_coils(signal.address, 1)[0]

        # Nearby register signals are combined into bounded reads. D400 and
        # D404 become one five-register request; D16 remains a one-register read.
        required_register_addresses: set[int] = set()
        for signal in registers:
            required_register_addresses.update(
                range(signal.address, signal.address + register_word_count(signal))
            )
        register_values: dict[int, int] = {}
        for start, quantity in grouped_ranges(
            required_register_addresses,
            max_gap=4,
            max_span=MAX_HOLDING_REGISTERS,
        ):
            block = client.read_holding_registers(start, quantity)
            for offset, value in enumerate(block):
                register_values[start + offset] = value
        for signal in registers:
            words = [
                register_values[address]
                for address in range(
                    signal.address,
                    signal.address + register_word_count(signal),
                )
            ]
            values[signal.name] = decode_register_value(signal, words)
        if capture_frames is not None:
            capture_frames.extend(client.frames)
    return values


def iso_times() -> tuple[str, str]:
    utc_now = datetime.now(timezone.utc)
    return (
        utc_now.isoformat(timespec="milliseconds"),
        utc_now.astimezone().isoformat(timespec="milliseconds"),
    )


def initialize_database(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS raw_samples (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            observed_at_utc TEXT NOT NULL,
            observed_at_local TEXT NOT NULL,
            module_name TEXT NOT NULL,
            module_ip TEXT NOT NULL,
            cycle_start INTEGER,
            cycle_complete INTEGER,
            cycle_time_raw INTEGER,
            cycle_time_seconds REAL,
            ok_total INTEGER,
            ng_total INTEGER,
            mapping_status TEXT NOT NULL,
            raw_json TEXT NOT NULL
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            observed_at_utc TEXT NOT NULL,
            observed_at_local TEXT NOT NULL,
            module_name TEXT NOT NULL,
            event_type TEXT NOT NULL,
            value INTEGER,
            delta INTEGER,
            observed_cycle_seconds REAL,
            details_json TEXT NOT NULL
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS collection_errors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            observed_at_utc TEXT NOT NULL,
            observed_at_local TEXT NOT NULL,
            module_name TEXT NOT NULL,
            module_ip TEXT NOT NULL,
            error_type TEXT NOT NULL,
            error_message TEXT NOT NULL
        )
        """
    )
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS protocol_frames (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sample_id INTEGER NOT NULL,
            module_name TEXT NOT NULL,
            transaction_id INTEGER NOT NULL,
            function INTEGER NOT NULL CHECK (function IN (1, 2, 3, 4)),
            address INTEGER NOT NULL,
            quantity INTEGER NOT NULL,
            request_adu_hex TEXT NOT NULL,
            response_adu_hex TEXT NOT NULL,
            FOREIGN KEY (sample_id) REFERENCES raw_samples(id)
        )
        """
    )
    connection.commit()
    return connection


RAW_FIELDS = [
    "observed_at_utc", "observed_at_local", "module_name", "module_ip",
    "cycle_start", "cycle_complete", "cycle_time_raw", "cycle_time_seconds",
    "ok_total", "ng_total", "mapping_status",
]
EVENT_FIELDS = [
    "observed_at_utc", "observed_at_local", "module_name", "event_type",
    "value", "delta", "observed_cycle_seconds",
]
ERROR_FIELDS = [
    "observed_at_utc", "observed_at_local", "module_name", "module_ip",
    "error_type", "error_message",
]


def append_csv(path: Path, fields: list[str], row: dict[str, Any]) -> None:
    is_new = not path.exists()
    with path.open("a", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        if is_new:
            writer.writeheader()
        writer.writerow(row)
        handle.flush()


def store_raw(
    database: sqlite3.Connection,
    raw_csv: Path,
    row: dict[str, Any],
    raw_values: dict[str, Any],
) -> int:
    cursor = database.execute(
        """
        INSERT INTO raw_samples (
            observed_at_utc, observed_at_local, module_name, module_ip,
            cycle_start, cycle_complete, cycle_time_raw, cycle_time_seconds,
            ok_total, ng_total, mapping_status, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row["observed_at_utc"], row["observed_at_local"],
            row["module_name"], row["module_ip"], row["cycle_start"],
            row["cycle_complete"], row["cycle_time_raw"],
            row["cycle_time_seconds"], row["ok_total"], row["ng_total"],
            row["mapping_status"], json.dumps(raw_values, sort_keys=True),
        ),
    )
    database.commit()
    append_csv(raw_csv, RAW_FIELDS, row)
    return int(cursor.lastrowid)


def store_protocol_frames(
    database: sqlite3.Connection,
    sample_id: int,
    module_name: str,
    frames: list[ProtocolFrame],
) -> None:
    """Store the exact bytes used to produce a decoded sample."""
    database.executemany(
        """
        INSERT INTO protocol_frames (
            sample_id, module_name, transaction_id, function, address,
            quantity, request_adu_hex, response_adu_hex
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                sample_id,
                module_name,
                frame.transaction_id,
                frame.function,
                frame.address,
                frame.quantity,
                frame.request_adu_hex,
                frame.response_adu_hex,
            )
            for frame in frames
        ],
    )
    database.commit()


def derive_events(
    module_name: str,
    values: dict[str, Any],
    state: RuntimeState,
    observed_at_utc: str,
    observed_at_local: str,
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    previous = state.previous
    now_monotonic = time.monotonic()
    if previous is None:
        events.append({"event_type": "BASELINE_ESTABLISHED"})
    else:
        if values["cycle_start"] and not previous["cycle_start"]:
            state.active_started_monotonic = now_monotonic
            state.active_started_utc = observed_at_utc
            events.append({"event_type": "CYCLE_START"})
        if values["cycle_complete"] and not previous["cycle_complete"]:
            elapsed = None
            if state.active_started_monotonic is not None:
                elapsed = round(now_monotonic - state.active_started_monotonic, 3)
            events.append(
                {"event_type": "CYCLE_COMPLETE", "observed_cycle_seconds": elapsed}
            )
            state.active_started_monotonic = None
            state.active_started_utc = None
        for key, event_type in (("ok_total", "OK_COUNT_CHANGE"), ("ng_total", "NG_COUNT_CHANGE")):
            if key not in values or key not in previous:
                continue
            delta = int(values[key]) - int(previous[key])
            if delta:
                events.append(
                    {"event_type": event_type, "value": int(values[key]), "delta": delta}
                )
    state.previous = dict(values)

    for event in events:
        event.update(
            {
                "observed_at_utc": observed_at_utc,
                "observed_at_local": observed_at_local,
                "module_name": module_name,
                "value": event.get("value"),
                "delta": event.get("delta"),
                "observed_cycle_seconds": event.get("observed_cycle_seconds"),
            }
        )
    return events


def store_event(
    database: sqlite3.Connection, events_csv: Path, event: dict[str, Any]
) -> None:
    database.execute(
        """
        INSERT INTO events (
            observed_at_utc, observed_at_local, module_name, event_type,
            value, delta, observed_cycle_seconds, details_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event["observed_at_utc"], event["observed_at_local"],
            event["module_name"], event["event_type"], event["value"],
            event["delta"], event["observed_cycle_seconds"],
            json.dumps(event, sort_keys=True),
        ),
    )
    database.commit()
    append_csv(events_csv, EVENT_FIELDS, event)


def store_collection_error(
    database: sqlite3.Connection,
    errors_csv: Path,
    module: dict[str, Any],
    error: BaseException,
) -> dict[str, Any]:
    observed_at_utc, observed_at_local = iso_times()
    row = {
        "observed_at_utc": observed_at_utc,
        "observed_at_local": observed_at_local,
        "module_name": module["name"],
        "module_ip": module["ip"],
        "error_type": type(error).__name__,
        "error_message": str(error),
    }
    database.execute(
        """
        INSERT INTO collection_errors (
            observed_at_utc, observed_at_local, module_name, module_ip,
            error_type, error_message
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        tuple(row[field] for field in ERROR_FIELDS),
    )
    database.commit()
    append_csv(errors_csv, ERROR_FIELDS, row)
    return row


def load_config(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CollectorError(f"Cannot load configuration: {error}") from error


def run(
    config_path: Path,
    *,
    once: bool,
    validate_only: bool,
    selected_modules: set[str] | None = None,
) -> int:
    config = load_config(config_path)
    validate_config(config)
    enabled = [module for module in config["modules"] if module.get("enabled")]
    if selected_modules:
        known_names = {module["name"] for module in config["modules"]}
        unknown = sorted(selected_modules - known_names)
        if unknown:
            raise CollectorError(
                f"Unknown module selection: {', '.join(unknown)}"
            )
        enabled = [
            module for module in enabled
            if module["name"] in selected_modules
        ]
        disabled_selected = sorted(
            selected_modules - {module["name"] for module in enabled}
        )
        if disabled_selected:
            raise CollectorError(
                "Selected module is disabled: " + ", ".join(disabled_selected)
            )

    for module in enabled:
        signals = signals_for_module(config, module)
        mapping = ", ".join(
            f"{signal.device}->{signal.address} (FC{signal.function:02d})"
            for signal in signals
        )
        print(
            f"Validated read-only mapping for {module['name']} "
            f"[{module['signal_profile']}]: {mapping}"
        )
    if validate_only:
        print(f"Configuration valid; {len(enabled)} module(s) enabled. No network request sent.")
        return 0
    if not enabled:
        raise CollectorError("No modules are enabled; no network request was sent")

    output_directory = (config_path.parent / config.get("output_directory", "data")).resolve()
    output_directory.mkdir(parents=True, exist_ok=True)
    database = initialize_database(output_directory / "fx5_data.sqlite3")
    raw_csv = output_directory / "raw_samples.csv"
    events_csv = output_directory / "events.csv"
    errors_csv = output_directory / "collection_errors.csv"
    states = {module["name"]: RuntimeState() for module in enabled}
    timeout = float(config["socket_timeout_seconds"])
    interval = float(config["poll_interval_seconds"])
    mapping_status = "candidate_fx5_default_not_program_verified"

    print(
        f"Starting sequential read-only collection for {len(enabled)} module(s). "
        f"Interval={interval}s timeout={timeout}s. Ctrl+C stops safely."
    )
    try:
        one_shot_failures = 0
        while True:
            loop_started = time.monotonic()
            for module in enabled:
                try:
                    signals = signals_for_module(config, module)
                    signal_profile = config["signal_profiles"][
                        module["signal_profile"]
                    ]
                    scale = signal_profile.get("cycle_time_scale_seconds")
                    frames: list[ProtocolFrame] = []
                    values = read_snapshot(
                        module, signals, timeout, capture_frames=frames
                    )
                    observed_at_utc, observed_at_local = iso_times()
                    cycle_time_raw = values.get("cycle_time")
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
                        "mapping_status": mapping_status,
                    }
                    sample_id = store_raw(database, raw_csv, row, values)
                    store_protocol_frames(
                        database, sample_id, module["name"], frames
                    )
                    events = derive_events(
                        module["name"], values, states[module["name"]],
                        observed_at_utc, observed_at_local,
                    )
                    for event in events:
                        store_event(database, events_csv, event)
                    print(json.dumps({**row, "events": [e["event_type"] for e in events]}))
                except (OSError, CollectorError) as error:
                    one_shot_failures += 1
                    error_row = store_collection_error(
                        database, errors_csv, module, error
                    )
                    print(
                        json.dumps(error_row),
                        file=sys.stderr,
                    )
            if once:
                if one_shot_failures:
                    print(
                        f"One-shot validation failed for {one_shot_failures} "
                        "module(s); inspect collection_errors.csv.",
                        file=sys.stderr,
                    )
                    return 1
                print(
                    f"One-shot validation succeeded for all {len(enabled)} "
                    "enabled module(s)."
                )
                return 0
            elapsed = time.monotonic() - loop_started
            time.sleep(max(0.0, interval - elapsed))
    except KeyboardInterrupt:
        print("\nCollector stopped safely.")
        return 0
    finally:
        database.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=Path("modules.json"))
    parser.add_argument("--once", action="store_true", help="Read one snapshot and exit")
    parser.add_argument(
        "--validate-config", action="store_true", help="Validate without network access"
    )
    parser.add_argument(
        "--confirm-read-only",
        action="store_true",
        help="Required acknowledgement before any PLC connection",
    )
    parser.add_argument(
        "--explain-requests",
        action="store_true",
        help="Print exact request bytes without opening a network connection",
    )
    parser.add_argument(
        "--module",
        action="append",
        dest="modules",
        help="Limit collection to one named enabled module; may be repeated",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.explain_requests:
        try:
            config = load_config(args.config)
            validate_config(config)
            explain_requests(config)
            return 0
        except CollectorError as error:
            print(f"Collector stopped: {error}", file=sys.stderr)
            return 1
    if not args.validate_config and not args.confirm_read_only:
        print(
            "Refusing network access: add --confirm-read-only after checking the IPs.",
            file=sys.stderr,
        )
        return 2
    try:
        return run(
            args.config,
            once=args.once,
            validate_only=args.validate_config,
            selected_modules=set(args.modules) if args.modules else None,
        )
    except CollectorError as error:
        print(f"Collector stopped: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
