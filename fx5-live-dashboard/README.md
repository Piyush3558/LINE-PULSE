# FX5 live dashboard

Local-only browser dashboard for the existing read-only Mitsubishi FX5
collector. It binds to `127.0.0.1`. The **Check connection** button tests the
five unique PLC endpoints on TCP 502; Start Collection appears only when all
five are reachable. Collection can start when at least one endpoint responds;
offline modules are logged while online modules continue saving. Opening the
page does not poll or connect to a PLC.

On startup, the operation cards also show the newest saved OK/NG snapshots for
OP10–OP40 from `data/raw_samples.csv` and the bounded discovery CSVs. A
**SAVED** badge and full sample date distinguish these historical cumulative
PLC totals from **LIVE** readings. OP50 counters remain unmapped and blank.

## Start

```bash
cd fx5-live-dashboard
python3 server.py
```

Open `http://127.0.0.1:8765` in Chrome. Press **Start collection** after the
manual connection check shows at least one endpoint online. Stop safely with the dashboard
button before closing the server with `Ctrl+C`.

On Windows, use the project-root `check_line_pulse.bat` and
`start_line_pulse.bat`. The latter runs an offline configuration/write check
before starting the same dashboard. See the project-root `README.md` for the
machine Ethernet, Wi-Fi and remote-access steps.

Data is stored separately under this project's `data/` directory:

- `fx5_data.sqlite3`
- `raw_samples.csv`
- `modules/op10.csv`, `modules/op20.csv`, `modules/op30.csv`,
  `modules/op40.csv`, `modules/op50a.csv`, and `modules/op50b.csv`.
  Each successful live reading is appended to its station file with a timestamp,
  mapped fields, and `raw_json`. The files are created when that station first
  returns a reading; stopping and restarting collection appends new rows.
- `events.csv`
- `collection_errors.csv`

The dashboard saves a reading locally before showing it as **LIVE**. If a PLC
read fails, no reading is invented for that poll; the error is recorded in
`collection_errors.csv`. OP50 OK/NG columns stay blank until their addresses
are verified. These files contain live dashboard captures, not the separate
bounded discovery captures in `../fx5-readonly-collector/discovery_data/`.

The dashboard cannot write PLC values or alter PLC settings. It reuses the
validated FC01/FC03 read plan from `../fx5-readonly-collector/modules.json`.
