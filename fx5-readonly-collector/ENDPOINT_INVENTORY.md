# Endpoint inventory extracted from the supplied status screenshot

This inventory is transcription evidence only. It does not authorize a network
connection and does not prove that TCP port 502, unit ID 1, or any M/D mapping
is correct for these endpoints.

| Displayed operation | Displayed PLC IP | Current interpretation |
|---|---|---|
| OP10 | 192.168.1.71 | candidate primary OP10 PLC |
| OP10A | 192.168.1.61 | additional operation; scope unresolved |
| OP20 | 192.168.1.76 | candidate OP20 PLC |
| OP30 | 192.168.1.41 | candidate OP30 PLC |
| OP40 | 192.168.1.46 | candidate OP40 PLC |
| OP50A | 192.168.1.51 | shares displayed IP with OP50B |
| OP50B | 192.168.1.51 | may share one PLC with OP50A; confirm |

## Questions that must be resolved

1. Does “five modules” mean OP10, OP20, OP30, OP40, and one OP50 PLC?
2. Is OP10A outside the requested production line, or must it also be logged?
3. Do OP50A and OP50B deliberately share one FX5 CPU/IP, or is the screenshot
   showing a configuration error?
4. Is port 502 enabled on every listed IP, and is unit ID 1 correct?
5. Which named signal profile belongs to each endpoint?

All endpoints remain disabled in `modules.example.json`. The collector will
also reject an enabled module that has no explicit signal profile.
