# Line Pulse part traceability plan

## Required evidence before live QR tracking

1. Identify the source of the QR value at OP10: PLC device range, scanner
   interface, HMI tag, or machine database. Record its encoding, maximum
   length, and the scan-valid/acknowledged event. Do not assume it is in a D
   register merely because the PLC is reachable over MODBUS/TCP.
2. For each OP10, OP20, OP30, OP40, and OP50 logical station, identify the
   active-part QR source or a verified transfer event that carries the same
   QR. An arrival order or counter difference alone cannot prove identity.
3. Identify each station's start, finish, OK, and NG event. OP50A and OP50B
   share one PLC, but which of them is the final acceptance gate must be
   confirmed from the machine program and HMI.
4. Confirm counter addresses with stopped/running captures and HMI totals.
   Counters show aggregate production, not the result of a specific QR.

## Intended data flow after validation

At a valid OP10 scan, create a part record keyed by the exact QR text and a
scan event. Each later station visit stores the same QR, station, start time,
finish time, and that station's result. The live dashboard shows the current
QR at a station only while an independently verified active signal and QR are
present. Otherwise it shows `Unknown`, not a guessed part number.

The part's final status stays `In progress` until the verified OP50 final
disposition event for that same QR. Then it becomes `Final OK` or `Final NG`.
Do not infer final status from OP10–OP40 results, cumulative OP50 OK/NG totals,
or which QR was previously at a station. Retain a separate state for missed
reads, rework, duplicate scans, and an OP50 result without a matching QR.

Dashboard station cards should eventually show current QR, station state,
last observed time, and station-specific outcome. A separate part-history
view should show the ordered visits and final result. Production totals need
a declared period or shift boundary; PLC cumulative values are not inherently
today's counts.

## Current status

OP50 OK/NG aggregate counter registers and all QR sources are unverified.
The existing dashboard must keep those fields unmapped until the evidence
above is available. No live part-tracking code should be enabled yet.
