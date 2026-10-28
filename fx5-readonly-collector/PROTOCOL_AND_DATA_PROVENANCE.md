# How the Ubuntu laptop communicates with the Mitsubishi FX5

## Short explanation for IT

The laptop does not receive a sentence or JSON object from the PLC. It opens a
TCP connection to the module IP on port 502 and sends a binary MODBUS/TCP read
request. The FX5 MODBUS server translates the requested MODBUS address to a PLC
device according to its GX Works3 device-assignment table, reads the current
value from CPU memory, and returns the raw bits or 16-bit words.

The PLC response contains addresses and raw values. It does **not** contain the
business labels “cycle time,” “OK parts,” or “NG parts.” Those labels came from
the supplied machine notes and must be verified against the PLC program, GX
Works3 cross-reference, or HMI.

## Exact request bytes

Run this command without connecting to a PLC:

```bash
python3 fx5_collector.py --config modules.example.json --explain-requests
```

For unit ID 1, the current candidate mapping produces:

### Read M130

```text
00 01 00 00 00 06 01 01 20 82 00 01
```

- transaction ID: `0001`
- protocol ID: `0000` (MODBUS)
- following length: `0006`
- unit ID: `01`
- function: `01` (read coils)
- address: `2082` hexadecimal = 8322 decimal
- quantity: `0001`

With the FX5 dedicated default allocation, coil 8322 is `M130` because M
devices begin at `0x2000`.

### Read M260

```text
00 02 00 00 00 06 01 01 21 04 00 01
```

Address `0x2104` is 8452 decimal, which is `0x2000 + 260`.

### Read D16

```text
00 03 00 00 00 06 01 03 00 10 00 01
```

Function 03 reads one holding register at zero-based address 16. Under the FX5
default allocation this is D16.

### Read D400 through D404

```text
00 04 00 00 00 06 01 03 01 90 00 05
```

Function 03 reads five consecutive holding registers beginning at decimal 400
(`0x0190`). The collector keeps D400 and D404 and uses a single bounded request
instead of two requests.

## Where each exported field originates

| Exported field | Direct source | Transformation |
|---|---|---|
| `cycle_start` | candidate M130 bit | current bit converted to 0/1 |
| `cycle_complete` | candidate M260 bit | current bit converted to 0/1 |
| `cycle_time_raw` | candidate D16 word | none |
| `cycle_time_seconds` | D16 | only calculated after a verified scale is configured |
| `ok_total` | candidate D400 word | none |
| `ng_total` | candidate D404 word | none |
| `observed_at_utc` | Ubuntu system clock | generated immediately after the snapshot |
| `observed_at_local` | Ubuntu system clock | UTC converted to the laptop timezone |
| `CYCLE_START` event | successive M130 samples | emitted only on a false-to-true edge |
| `CYCLE_COMPLETE` event | successive M260 samples | emitted only on a false-to-true edge |
| `OK_COUNT_CHANGE` | successive D400 samples | new value minus previous value |
| `NG_COUNT_CHANGE` | successive D404 samples | new value minus previous value |
| observed cycle seconds | laptop monotonic clock | time between observed start and complete edges |

The signal profile—not the PLC model name—declares whether a D value is
`uint16`, `int16`, `uint32`, or `int32`. For a 32-bit value it also declares
whether the first D register is the high or low word. This prevents an
unverified signedness or word-order guess from being hidden in the decoder.

## Meaning of “all PLC data”

The CPU model defines available memory devices, not their machine-specific
meaning. Reading every M and D address would return thousands of internal
program values, increase traffic, and still would not identify cycle time or
product results. Therefore this collector intentionally reads only approved
devices. A complete business-data list requires the program/device map.

## Trust boundaries

1. **Transport confirmed:** a valid MODBUS response proves the endpoint answered.
2. **Address translation candidate:** the default FX5 mapping explains the
   address, but GX Works3 can customize it.
3. **Business meaning unverified:** a value becomes “cycle time” or “OK count”
   only after comparison with program/HMI evidence.
4. **Historical date unavailable from a current counter:** laptop timestamps
   show when a value was observed, not when an older counted part was made.
5. **Derived events are local analysis:** they are reproducible calculations
   from successive raw samples and are stored separately from raw evidence.
6. **Process restarts create a new baseline:** the collector does not invent a
   counter delta or cycle duration across an unobserved restart gap.

## Database proof trail

For every successful snapshot, `raw_samples` stores the decoded values and
`protocol_frames` stores the exact request and response ADUs. The tables are
joined with `protocol_frames.sample_id = raw_samples.id`. This makes the proof
chain explicit:

```text
module IP -> request bytes -> response bytes -> decoded raw value -> derived event
```

The one-shot validation returns a non-zero exit status when any enabled module
times out, rejects the request, or returns an invalid response. It never reports
an all-module success after a partial read.
