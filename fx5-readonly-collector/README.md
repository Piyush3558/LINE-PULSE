# Mitsubishi FX5 read-only collector

This collector records known production signals from Mitsubishi MELSEC iQ-F
FX5 PLCs over MODBUS/TCP. It is deliberately narrow:

- read-only functions only (`FC01`, `FC02`, `FC03`, `FC04`);
- no discovery scan;
- sequential, low-rate polling;
- short socket timeouts;
- disabled modules by default;
- raw evidence is stored separately from derived events.

## Bounded discovery for OP40 and OP50

Do not scan complete PLC memory. When a documented signal is missing, use
`fx5_bounded_discovery.py` to capture only explicit nearby M/D ranges for one
physical PLC at a time. Stop the live dashboard collector first. The tool uses
only FC01/FC03, enforces at least a 10-second interval, caps a run at 30
minutes, performs no automatic retries, and stops after three consecutive
failures.

Review the exact plan without contacting a PLC:

```bash
python3 fx5_bounded_discovery.py explain --module OP40
python3 fx5_bounded_discovery.py explain --module OP50
```

Capture one station for ten minutes:

```bash
python3 fx5_bounded_discovery.py capture --module OP40 --minutes 10 --confirm-read-only
```

Analyze the CSV path printed by the capture command:

```bash
python3 fx5_bounded_discovery.py analyze discovery_data/op40_YYYYMMDD_HHMMSS.csv
```

Changed devices are candidates only. Confirm them against known HMI cycle
starts, completions, and OK/NG results before assigning meanings.

## Important mapping fact

With the Mitsubishi **FX5 dedicated default MODBUS allocation**:

| PLC device | MODBUS data type | Zero-based MODBUS address |
|---|---|---:|
| `M130` | Coil | `0x2000 + 130 = 8322` |
| `M260` | Coil | `0x2000 + 260 = 8452` |
| `D16` | Holding register | `16` |
| `D400` | Holding register | `400` |
| `D404` | Holding register | `404` |

These translations are valid only when the PLC uses Mitsubishi's default FX5
device-allocation pattern. GX Works3 can customize the MODBUS device
assignment, so the configuration must eventually be checked against the PLC
project or an exported device-assignment screenshot.

### OP50 counter mismatch (2026-10-26)

The OP50 HMI showed OK=2331 and NG=3132, while a direct read of OP50
`D400` and `D404` returned 12336 and 12594 twice. These devices are **not
validated OP50 part counters** and are intentionally omitted from both OP50
signal profiles. Their hexadecimal values are `0x3030` and `0x3132`, which
look like pairs of ASCII digits (`00` and `12`); that is a clue, not a proven
meaning. Find the OP50 HMI counter device addresses or ladder counter
instructions before assigning OK/NG totals.

## What the PLC does and does not provide

An FX5 contains thousands of program devices. Their business meaning comes
from the machine program. The CPU model alone cannot reveal which device means
cycle time, product ID, fault code, or OK/NG. A tag/device list, GX Works3
cross-reference, HMI screen comparison, or one controlled production cycle is
required to validate those meanings.

The collector timestamps data when the laptop observes it. That timestamp does
not prove when an old accumulated counter value was originally produced.

## Setup

1. Copy the example configuration:

   ```bash
   cd fx5-readonly-collector
   cp modules.example.json modules.json
   ```

2. Put the five real module IP addresses in `modules.json`. Every enabled
   module must explicitly select a named `signal_profile`. The example assigns
   the OP10 candidate profile only to OP10; it deliberately leaves OP20–OP50
   without profiles so OP10 addresses cannot be silently reused for them.
   Add a profile from that module's PLC/HMI evidence, select it, and only then
   change the module from `"enabled": false` to `"enabled": true`.

3. Validate the file without touching any PLC:

   ```bash
   python3 fx5_collector.py --config modules.json --validate-config
   ```

   To show IT the exact binary requests without touching a PLC:

   ```bash
   python3 fx5_collector.py --config modules.json --explain-requests
   ```

4. When the machine is stopped and the IPs have been checked, take exactly one
   bounded read from every enabled module:

   ```bash
   python3 fx5_collector.py --config modules.json --once --confirm-read-only
   ```

5. Only after the one-shot values match the HMI, start continuous collection:

   ```bash
   python3 fx5_collector.py --config modules.json --confirm-read-only
   ```

Stop safely with `Ctrl+C`.

To retry or test only one enabled logical station without contacting the
others, use `--module`, for example:

```bash
python3 fx5_collector.py --config modules.json --module OP10 \
  --once --confirm-read-only
```

`--module` may be repeated to select several named stations. An unknown or
disabled selection is rejected before any network connection is opened.

6. Summarize the collected evidence for a local calendar date:

   ```bash
   python3 fx5_report.py --database data/fx5_data.sqlite3 --date 2026-10-15
   ```

   Use `--json` when the result will be consumed by the future API or web
   dashboard.

7. Generate the IT-facing proof report. It shows configuration and exact
   request bytes even before collection; after collection it also includes the
   latest raw response frames:

   ```bash
   python3 fx5_audit_report.py --config modules.json \
     --database data/fx5_data.sqlite3 --output fx5_audit.md
   ```

See `MODULE_INFORMATION_REQUIRED.md` for the exact five-module information
that must be obtained before live collection. `ENDPOINT_INVENTORY.md` records
the IPs visible in the supplied screenshot and the unresolved OP10A/OP50A/B
scope; those addresses remain disabled until confirmed.

## Output

The `data/` directory contains:

- `fx5_data.sqlite3`: authoritative local database;
- `raw_samples.csv`: every successful snapshot;
- `events.csv`: detected cycle edges and counter changes.
- `collection_errors.csv`: timestamped connection/protocol failures for audit.

The SQLite `protocol_frames` table preserves the exact hexadecimal MODBUS/TCP
request and response for every successful read. Each frame links to its
`raw_samples.id`, so IT can trace a decoded value back to the bytes returned by
the PLC. Only successful, fully validated read responses are stored there.

The one-shot command exits with a failure status if even one enabled module
cannot be read. A printed success therefore means every enabled module returned
one complete four-request snapshot; it does not yet prove the business meaning
of the addresses.

The report distinguishes `current_ok_total`/`current_ng_total` (cumulative PLC
snapshots) from `observed_ok_increase`/`observed_ng_increase` (positive counter
changes actually witnessed by this collector during the requested date). This
prevents an old counter value from being incorrectly described as today's
production.

It also separates the **collector evidence window** (first/last successful
sample and sample count) from **machine work witnessed in completed cycles**
(the sum of locally observed start-to-complete durations). Network-connected
time is not reported as machine working time.

Modules with connection/protocol errors but no successful sample are retained
in the report with status `no_successful_sample`; they are never silently
omitted. A module with both samples and errors is marked `success_with_errors`.

The first successful sample after each collector start produces a
`BASELINE_ESTABLISHED` event. More than one baseline in a reporting period
indicates a restart and therefore a possible observation gap. Counter movement
during that gap is not claimed as continuously witnessed production.

`cycle_time_raw` is intentionally raw until the engineer/HMI confirms whether
`D16` is milliseconds, tenths of a second, seconds, or another unit. Set
`cycle_time_scale_seconds` inside that module's signal profile only after that
validation.

Register profiles support `uint16`, `int16`, `uint32`, and `int32`. Two-word
values must explicitly declare `word_order` as `high_word_first` or
`low_word_first`. The example remains `uint16` because no evidence has yet
proved that OP10 uses a 32-bit or signed representation.

Only `cycle_start` and `cycle_complete` are mandatory for a logical station.
Cycle time and OK/NG counters are stored when their addresses are supplied; an
unmapped value remains empty and is never replaced with zero or copied from a
different station.

Cycle start/complete are detected by sampled edges. If either PLC bit is a
short pulse that can turn on and off between polling intervals, the collector
may miss it. Before production use, confirm the pulse duration or ask for a
latched/handshake bit; do not simply increase polling load without approval.

## Continuous operation after validation

`fx5-collector.service.example` is a hardened user-service template. Do not
enable it before the one-shot values have been validated against the HMI. After
the five IPs and mapping are approved, copy it to
`~/.config/systemd/user/fx5-collector.service`, then use:

```bash
systemctl --user daemon-reload
systemctl --user enable --now fx5-collector.service
systemctl --user status fx5-collector.service
```

The collector continues past individual module timeouts and records every
failure in SQLite and CSV. It never substitutes a stale value for a failed
read.

## Required evidence for a production-ready mapping

For each module obtain:

- exact FX5 CPU model (`FX5U`, `FX5UC`, `FX5UJ`, etc.);
- IP address, MODBUS/TCP port, and unit ID;
- GX Works3 MODBUS/TCP device-assignment export or screenshot;
- program/HMI evidence for every named device;
- data type, signedness, word order, units, reset behavior, and rollover;
- one known OK cycle and one known NG cycle for comparison.
