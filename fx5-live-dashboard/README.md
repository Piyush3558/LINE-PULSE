# FX5 live dashboard

Local-only browser dashboard for the existing read-only Mitsubishi FX5
collector. It binds to `127.0.0.1`, checks the five unique PLC endpoints on TCP
502, and reveals the Start Collection button only when all five are reachable.

## Start

```bash
cd fx5-live-dashboard
python3 server.py
```

Open `http://127.0.0.1:8765` in Chrome. Press **Start collection** after the
connection check shows 5/5 endpoints online. Stop safely with the dashboard
button before closing the server with `Ctrl+C`.

Data is stored separately under this project's `data/` directory:

- `fx5_data.sqlite3`
- `raw_samples.csv`
- `events.csv`
- `collection_errors.csv`

The dashboard cannot write PLC values or alter PLC settings. It reuses the
validated FC01/FC03 read plan from `../fx5-readonly-collector/modules.json`.
