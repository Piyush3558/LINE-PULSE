# Line Pulse

Local production dashboard and read-only MODBUS/TCP collector for Mitsubishi
MELSEC iQ-F FX5 PLCs. View station signals in a browser and record raw samples,
cycle events, connection errors, and protocol evidence in CSV and SQLite.

## Requirements

- Python 3.10 or newer. Only the Python standard library is required; no pip packages.
- Ethernet access to the PLC network, with MODBUS/TCP available on port 502.
- A browser on the computer running the dashboard.

## Get the code

```bash
git clone https://github.com/Piyush3558/LINE-PULSE.git
cd LINE-PULSE
```

Alternatively, use **Code > Download ZIP** on GitHub and extract it. Keep both
project folders together. Review `fx5-readonly-collector/modules.json` before
connecting: it contains the current station configuration with stations enabled.

## Run on Windows

Install Python, then copy or extract the project to `C:\Line-Pulse`.
Open Command Prompt and run:

```bat
cd /d C:\Line-Pulse\fx5-live-dashboard
py -3 server.py
```

Open **http://127.0.0.1:8765** on that PC. Click **Check connection**, then
**Start collection** once all five configured PLC endpoints are reachable.
Stop using the dashboard before pressing `Ctrl+C` in the terminal.

### Ethernet, dongle, and AnyDesk

1. Connect Ethernet to the machine network that reaches all PLCs.
2. Assign an unused Ethernet IPv4 address in the machine subnet with the subnet mask confirmed by the network team. For a directly connected machine subnet, leave its gateway and DNS blank.
3. Use the dongle for internet access, on a different subnet from the machine network. Leave network bridging and Internet Connection Sharing off.
4. Connect through AnyDesk and view the Windows PC's browser at `http://127.0.0.1:8765`.
5. Keep the PC awake and the server terminal running while collecting.

The dashboard listens on localhost by default. AnyDesk viewing does not require
exposing the dashboard HTTP port to the internet. Windows operation still needs
verification on the target PC.

## Run on Linux

From the repository root:

```bash
cd fx5-live-dashboard
python3 server.py
```

Open **http://127.0.0.1:8765**, check connections, and start collection.

## Current configuration

| Station | PLC IP | Port |
| --- | --- | --- |
| OP10 | 192.168.1.71 | 502 |
| OP20 | 192.168.1.76 | 502 |
| OP30 | 192.168.1.41 | 502 |
| OP40 | 192.168.1.46 | 502 |
| OP50A / OP50B | 192.168.1.51 | 502 |

These settings are installation-specific. Edit `fx5-readonly-collector/modules.json`
for another installation. `modules.example.json` provides a disabled template.

## Standalone collector

From `fx5-readonly-collector`, validate without contacting PLCs:

```bash
python3 fx5_collector.py --config modules.json --validate-config
python3 fx5_collector.py --config modules.json --explain-requests
```

After confirming the addresses, take one bounded read from each enabled station:

```bash
python3 fx5_collector.py --config modules.json --once --confirm-read-only
```

After comparing readings with the HMI, start continuous collection:

```bash
python3 fx5_collector.py --config modules.json --confirm-read-only
```

On Windows, replace `python3` with `py -3`. Run either the dashboard collector or
the standalone collector at a time. Stop live collection before using discovery tools.

## Data and limitations

Dashboard output is stored in `fx5-live-dashboard/data/`. The standalone collector
uses its configured output directory, normally `data/` relative to the working directory.

- `fx5_data.sqlite3`: samples, events, errors, and protocol evidence.
- `raw_samples.csv`: successful snapshots.
- `events.csv`: observed cycle edges and counter changes.
- `collection_errors.csv`: connection and protocol failures.

Generated data, discovery captures, and Python caches are excluded from Git.
The dashboard creates its data directory when collection starts.

PLC communication is restricted to read functions. Signal meanings still require
confirmation against the HMI or PLC documentation. OP50 OK/NG counters are
currently unmapped and remain empty. Raw cycle-time units require validation.
Short pulses may be missed between polls. Existing cumulative counters do not
represent production witnessed during the current collection session.

## Tests

From the repository root on Linux:

```bash
python3 -m unittest discover -s fx5-readonly-collector -p 'test_*.py'
```

On Windows:

```bat
py -3 -m unittest discover -s fx5-readonly-collector -p "test_*.py"
```

Tests use local fixtures and loopback servers; they do not require machine access.

## Project folders

- `fx5-live-dashboard/`: browser dashboard, local API, and collection control.
- `fx5-readonly-collector/`: collector, configuration, reporting, tests, and bounded discovery tools.

See the [collector documentation](fx5-readonly-collector/README.md) for mapping,
discovery, and reporting details. The Linux systemd service example contains
installation-specific paths that must be updated before use.
