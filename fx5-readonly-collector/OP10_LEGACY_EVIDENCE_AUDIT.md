# OP10 legacy collection evidence audit

Audit date: 2026-10-15  
Source CSV: `/home/piyush/Documents/op10_events.csv`  
Source logger: `/home/piyush/Documents/op10_readonly_logger.py`

## Integrity fingerprints

- CSV SHA-256: `99149fc26e7de78b5ef754a9e81677f10a34d62e5422aea57c76eca99168f33c`
- Logger SHA-256: `1453d2e7761748cdf8131039a1e80b728aad92393450a41c2ca8fd9bf6134224`

These hashes identify the exact files inspected for this audit.

## What was actually recorded

The CSV contains six samples at two-second intervals:

- first laptop timestamp: `2026-10-13T16:27:08+05:30`
- last laptop timestamp: `2026-10-13T16:27:18+05:30`
- `cycle_time_raw`: `0` in all six samples
- `ok_total`: `17` in all six samples
- `ng_total`: `19` in all six samples
- no counter change was observed
- no cycle event was observed

The logger sent MODBUS FC03 read requests for holding register 16 and for the
five-register block 400 through 404. Therefore `0`, `17`, and `19` were raw
values returned by the endpoint, assuming the responses passed the logger's
transaction, protocol, unit-ID, function, and byte-count checks.

Under Mitsubishi's default FX5 dedicated MODBUS allocation, holding register
16 corresponds to `D16`, register 400 to `D400`, and register 404 to `D404`.
GX Works3 can customize this allocation, so their production meaning is still
**candidate/unverified** until the PLC project, device assignment, or HMI is
compared.

## What was not recorded

The CSV values `candidate_cycle_start = 0` and
`candidate_cycle_complete = 0` are **not PLC readings**. In the inspected
logger, both were hardcoded on every loop:

```python
start = False
complete = False
```

The existing `read_coil()` function was never called inside the collection
loop. Consequently:

- the old file cannot prove whether M130 or M260 was ON or OFF;
- it cannot establish cycle start or completion;
- it cannot calculate machine working time;
- it cannot establish the production date of the 17 OK and 19 NG cumulative
  counts.

The timestamps came from the Ubuntu laptop at observation time, not from a PLC
history record. They prove only that the laptop observed the same cumulative
values during that ten-second window.

## Why the original coil request failed

For the default FX5 dedicated MODBUS mapping, M devices begin at coil address
`0x2000`:

- `M130` -> `0x2000 + 130` -> decimal coil `8322`
- `M260` -> `0x2000 + 260` -> decimal coil `8452`

Reading coil 130 does not read M130 under that mapping. The replacement
collector uses 8322 and 8452 and labels the mapping unverified until compared
with GX Works3/HMI evidence.

## Defensible statement for IT or production

> On 13 October 2026 between 16:27:08 and 16:27:18 IST, the Ubuntu laptop
> successfully received six read-only MODBUS/TCP snapshots from the endpoint.
> Candidate holding registers 16, 400, and 404 returned stable raw values 0,
> 17, and 19. The file did not read cycle-start or cycle-complete bits, and the
> counter values cannot be assigned to that date without earlier history or a
> counter reset/baseline.

## Next evidence gate

1. Confirm the five module IP addresses, port, and unit IDs.
2. Confirm the GX Works3 MODBUS/TCP device assignment uses the FX5 dedicated
   default pattern or provide the customized allocation.
3. Run one bounded read with the corrected addresses while the machine/HMI
   state is known.
4. Observe one controlled cycle and compare M130, M260, D16, D400, and D404
   with the HMI.
5. Only then enable continuous logging and production reporting.
