"""Local PostgreSQL persistence for read-only Line Pulse observations."""

from __future__ import annotations

import json
import os
from typing import Any


DEFAULT_DSN = "dbname=line_pulse host=/var/run/postgresql"


class PostgresStoreError(RuntimeError):
    pass


class PostgresStore:
    def __init__(self, connection: Any) -> None:
        self.connection = connection

    @classmethod
    def connect(cls) -> "PostgresStore":
        try:
            import psycopg
        except ImportError as error:
            raise PostgresStoreError(
                "PostgreSQL driver is missing. Run with the project's .venv/bin/python."
            ) from error
        try:
            connection = psycopg.connect(
                os.environ.get("LINE_PULSE_PG_DSN", DEFAULT_DSN),
                connect_timeout=3,
                autocommit=True,
            )
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT to_regclass('line_pulse.plc_samples'), "
                    "to_regclass('line_pulse.discovery_values')"
                )
                if any(value is None for value in cursor.fetchone()):
                    raise PostgresStoreError(
                        "Line Pulse tables are missing. Apply database/schema.sql first."
                    )
        except Exception as error:
            if "connection" in locals():
                connection.close()
            if isinstance(error, PostgresStoreError):
                raise
            raise PostgresStoreError(f"PostgreSQL unavailable: {error}") from error
        return cls(connection)

    def close(self) -> None:
        self.connection.close()

    def store_sample(
        self, row: dict[str, Any], raw_values: dict[str, Any],
        frames: list[Any], source: str,
    ) -> int:
        try:
            with self.connection.transaction():
                with self.connection.cursor() as cursor:
                    cursor.execute(
                        """
                        INSERT INTO line_pulse.plc_samples (
                            source, observed_at_utc, observed_at_local,
                            module_name, module_ip, cycle_start, cycle_complete,
                            cycle_time_raw, cycle_time_seconds, ok_total, ng_total,
                            mapping_status, raw_values
                        ) VALUES (
                            %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb
                        )
                        ON CONFLICT (source, observed_at_utc, module_name)
                        DO UPDATE SET raw_values = EXCLUDED.raw_values
                        RETURNING id
                        """,
                        (
                            source, row["observed_at_utc"], row["observed_at_local"],
                            row["module_name"], row["module_ip"], row["cycle_start"],
                            row["cycle_complete"], row["cycle_time_raw"],
                            row["cycle_time_seconds"], row["ok_total"],
                            row["ng_total"], row["mapping_status"],
                            json.dumps(raw_values, sort_keys=True),
                        ),
                    )
                    sample_id = int(cursor.fetchone()[0])
                    for frame in frames:
                        cursor.execute(
                            """
                            INSERT INTO line_pulse.protocol_frames (
                                sample_id, module_name, transaction_id, function,
                                address, quantity, request_adu_hex, response_adu_hex
                            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                            """,
                            (
                                sample_id, row["module_name"], frame.transaction_id,
                                frame.function, frame.address, frame.quantity,
                                frame.request_adu_hex, frame.response_adu_hex,
                            ),
                        )
            return sample_id
        except Exception as error:
            raise PostgresStoreError(f"Could not save PLC sample: {error}") from error

    def store_event(self, event: dict[str, Any], source: str) -> None:
        try:
            self.connection.execute(
                """
                INSERT INTO line_pulse.events (
                    source, observed_at_utc, observed_at_local, module_name,
                    event_type, value, delta, observed_cycle_seconds, details
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
                """,
                (
                    source, event["observed_at_utc"], event["observed_at_local"],
                    event["module_name"], event["event_type"], event["value"],
                    event["delta"], event["observed_cycle_seconds"],
                    json.dumps(event, sort_keys=True),
                ),
            )
        except Exception as error:
            raise PostgresStoreError(f"Could not save event: {error}") from error

    def store_error(self, row: dict[str, Any], source: str) -> None:
        try:
            self.connection.execute(
                """
                INSERT INTO line_pulse.collection_errors (
                    source, observed_at_utc, observed_at_local, module_name,
                    module_ip, error_type, error_message
                ) VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    source, row["observed_at_utc"], row["observed_at_local"],
                    row["module_name"], row["module_ip"], row["error_type"],
                    row["error_message"],
                ),
            )
        except Exception as error:
            raise PostgresStoreError(f"Could not save collection error: {error}") from error

    def store_discovery_sample(
        self, capture_file: str, sample_number: int, module_name: str,
        module_ip: str, observed_at_utc: str, observed_at_local: str,
        values: list[tuple[str, int]],
    ) -> None:
        try:
            with self.connection.transaction():
                with self.connection.cursor() as cursor:
                    cursor.execute(
                        """
                        INSERT INTO line_pulse.discovery_samples (
                            capture_file, sample_number, observed_at_utc,
                            observed_at_local, module_name, module_ip
                        ) VALUES (%s, %s, %s, %s, %s, %s)
                        ON CONFLICT (capture_file, sample_number, module_name)
                        DO UPDATE SET observed_at_utc = EXCLUDED.observed_at_utc
                        RETURNING id
                        """,
                        (
                            capture_file, sample_number, observed_at_utc,
                            observed_at_local, module_name, module_ip,
                        ),
                    )
                    sample_id = int(cursor.fetchone()[0])
                    for device, value in values:
                        cursor.execute(
                            """
                            INSERT INTO line_pulse.discovery_values (sample_id, device, value)
                            VALUES (%s, %s, %s)
                            ON CONFLICT (sample_id, device)
                            DO UPDATE SET value = EXCLUDED.value
                            """,
                            (sample_id, device, int(value)),
                        )
        except Exception as error:
            raise PostgresStoreError(f"Could not save discovery sample: {error}") from error
