# Five-module information required before live collection

Complete one row per PLC/module. Do not infer missing values from OP10.

| Module | Exact FX5 CPU | IP | Port | Unit ID | Signal profile evidence |
|---|---|---|---:|---:|---|
| OP10 | | 192.168.1.71 | 502 | 1 (confirm) | candidate notes only |
| OP20 | | 192.168.1.76 (screenshot; confirm) | 502 | 1 (confirm) | required |
| OP30 | | 192.168.1.41 (screenshot; confirm) | 502 | 1 (confirm) | required |
| OP40 | | 192.168.1.46 (screenshot; confirm) | 502 | 1 (confirm) | required |
| OP50 | | 192.168.1.51 (A/B both shown; confirm) | 502 | 1 (confirm) | required |

The screenshot also shows OP10A at `192.168.1.61`. Confirm whether it is in
scope. See `ENDPOINT_INVENTORY.md` for the full transcription and ambiguities.

For every module, collect:

1. GX Works3 MODBUS/TCP device-assignment screenshot/export.
2. Program cross-reference or HMI evidence for cycle start, cycle complete,
   cycle time, OK total, and NG total.
3. Device type/address, data type, signedness, number of words, byte/word order,
   engineering unit, scale, reset behavior, and rollover maximum.
4. Whether start/complete are pulses or latched signals and their minimum ON time.
5. One controlled OK cycle and one controlled NG cycle with HMI values before
   and after each cycle.
6. Whether counters reset by shift, date, recipe, power cycle, operator action,
   or never.

## Validation gate

An IP address and open TCP port 502 prove only reachability. Before continuous
collection, every enabled module must pass one bounded read-only snapshot and
its values must match a known HMI/production state. No PLC settings or program
changes are part of this validation.
