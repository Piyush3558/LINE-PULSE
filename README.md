# Line Pulse

Line Pulse collects read-only Modbus/TCP data from Mitsubishi FX5 PLCs. The
React dashboard and Node.js API use PostgreSQL for machine setup, mapping
history, and telemetry. A separate Node.js process performs PLC reads.

## Run on Windows with the shared database

### Portable Windows ZIP

For a Windows PC without Node.js, use the **Line-Pulse-Windows-x64.zip** release.
In File Explorer, choose **Extract All** to a fresh folder under your own
Downloads or Documents. Open the extracted `LinePulse` folder and double-click
`Start-Line-Pulse.cmd`. It runs `npm run dev` for both the frontend and backend.
To type the command yourself, open `Open-Line-Pulse-Terminal.cmd` and run
`npm run dev`. Open [http://127.0.0.1:5173](http://127.0.0.1:5173) and sign in to
the existing Line Pulse account.

The portable release includes Node.js, npm, the Windows dependencies, and a
profile for the shared database. It requires a 64-bit x64 Windows PC and a
network connection to the Linux database host. Keep the ZIP private because
it contains database credentials. Run the initial setup while the machine's
current collector is stopped so its assignment can transfer.

From this Linux checkout, rebuild the release using
`./scripts/package-windows.sh "$(cat data/windows-profile-location.txt)"`.

### Run from a source checkout

The Linux laptop hosts PostgreSQL. Install Node.js 24 LTS (24.15 or later) on
Windows and copy the Line Pulse code to that laptop. This mode uses the Linux
database from both dashboards and stores readings collected by Windows there.

1. Connect Windows to a network that can reach the Linux database host.
   The Windows collector also needs a network route to the PLCs. For example,
   it can use Wi-Fi for PostgreSQL and Ethernet for the machine network.
2. Extract the Windows profile's `.env` and `line-pulse-db-ca.pem` into the
   Windows project root beside `setup_windows.bat`. The `.env` contains the
   app database credentials. Do not commit the profile or share it publicly.
3. Run `setup_windows.bat`. It installs dependencies, builds the dashboard,
   checks both database connections using TLS, and assigns the profile's
   machine to this collector. Stop collection on the current laptop before
   transferring the assignment. There is one assigned collector per machine.
4. Run `start_line_pulse.bat` and sign in at
   [http://127.0.0.1:8765](http://127.0.0.1:8765) using the existing Line Pulse
   account. The two `npm run dev` commands below also work with this profile.
5. Review and publish the PLC mappings for commissioning, then enable the
   machine and its configured modules. Use **Check connection** and **Start
   collection** in **Overview**. Every successful poll uploads to the Linux
   database. If that connection drops after collection starts, the collector
   queues polls locally and uploads them when it reconnects.

PostgreSQL listens on `0.0.0.0:55432` and accepts authenticated TLS connections
from any reachable IPv4 client. The current client address for the Windows
profile is `10.251.25.124:55432`. From Windows,
`Test-NetConnection 10.251.25.124 -Port 55432` checks TCP reachability, and
`npm run line-pulse -- db-check` checks authentication and TLS. Keep the Linux
laptop awake and PostgreSQL running during a collection session. If the host
IP changes, update the listener and generate a new profile.

On the Linux database laptop, use these commands to configure the listener and
prepare a profile. `0.0.0.0/0` accepts any IPv4 source and binds every IPv4
interface. For a restricted setup, pass the Windows IP as a `/32` or a trusted
LAN subnet. The first argument is the actual server IP used to verify TLS.

```bash
./scripts/enable-shared-db.sh 10.251.25.124 0.0.0.0/0
npm run line-pulse -- make-windows-profile 10.251.25.124 --machine MACHINE_001
```

After a Linux reboot, `./scripts/linux-local.sh start-db` starts only the
database. To assign a newly created machine to an installed laptop, run
`npm run line-pulse -- use-local-collector --machine MACHINE_CODE` on that
laptop. Use a separate profile for each collector.

## Run a separate database on Windows

1. Install Node.js 24 LTS (24.15 or later) and PostgreSQL 18. Start PostgreSQL
   and keep the administrator password from the PostgreSQL installer.
2. Use a fresh checkout on Windows so it can create Windows-specific database
   settings. Double-click `setup_windows.bat`. It
   installs npm dependencies, prompts for your local PostgreSQL connection,
   creates an independent Line Pulse database and admin account, and builds the dashboard.
3. Double-click `start_line_pulse.bat` and open
   [http://127.0.0.1:8765](http://127.0.0.1:8765). Sign in as `admin` with
   just the password value in `data/initial-admin.txt`.

### Develop on Windows or Linux

After database setup and `npm ci`, run `npm run dev` at the repository root to
start both applications. To start them separately, use these commands in two
terminals:

| Terminal | Commands |
|---|---|
| Backend | `cd backend` then `npm run dev` |
| Frontend | `cd frontend` then `npm run dev` |

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) for the frontend dev server.
The backend uses port `8765` by default and starts the idle PLC worker. Stop
`start_line_pulse.bat` or the local Linux API and worker services before using
the development processes for the same installation. The PostgreSQL server
should remain running. On the configured Linux laptop, use
`systemctl --user stop line-pulse-api line-pulse-collector`.

## Open the local application

Open [Line Pulse](http://127.0.0.1:8765). The initialized Linux pilot has a
local PostgreSQL cluster under `data/pg18`. The first sign-in uses the
credentials in `data/initial-admin.txt`. Keep that file and `.env` private.
Open **pgAdmin 4 (Line Pulse)** from the Linux application launcher, or run
`~/.local/bin/pgadmin-line-pulse`. Under **Servers → Line Pulse**, expand
**Databases → line_pulse → Schemas → line_pulse_v2 → Tables**. The connection
uses port `55432` and the Unix socket in `data/pgsocket`.

On that device, run `./scripts/linux-local.sh start` after a reboot. Run
`./scripts/linux-local.sh status` to check PostgreSQL, the API, and the worker.
The Linux API listens on loopback. PostgreSQL accepts local socket connections
and authenticated TLS connections from the configured IPv4 range.

In **Setup**, select a machine and module, review the draft's PLC read plan,
and publish it for commissioning after checking the addresses. Enable the
machine and the modules you want to collect. In **Overview**, use **Check
connection** and **Start collection**. The worker needs at least one
configured, reachable endpoint to start. Compare observed values with the HMI
before creating a verified production mapping. **Stop** stops software
polling. The application sends FC01 and FC03 reads only.

Use **Reading history → Data → Archived samples** to see imported SQLite
observations with their original source. Current samples and events have CSV
exports and a commissioning or production filter. OK and NG are cumulative
PLC counters. Missing values are shown as a dash. OP50A and OP50B share a PLC
endpoint and have independent module mappings.

## Where to see a machine in pgAdmin

Expand **Servers → Line Pulse → Databases → line_pulse → Schemas →
line_pulse_v2 → Tables**. Right-click a table and select **View/Edit Data →
All Rows**. The `line_pulse_qa` database is for tests.

| Table | What you will see |
|---|---|
| `machines` | One row per new or existing machine, including `machine_id`, code, name, time zone, polling interval, and enabled status. |
| `modules` | Modules such as OP10 and OP20. Filter `machine_id` to see the modules of one machine. |
| `plc_endpoints` | The machine's PLC IP addresses, ports, and unit IDs. Each row has a `machine_id`. |
| `module_mapping_versions` and `module_signal_mappings` | Draft and published signal maps. Join on `mapping_version_id` to find the device, address, data type, scale, and verification status. |
| `plc_samples`, `plc_events`, and `plc_collection_errors` | Successful new readings, derived events, and poll failures. Filter readings and errors by `module_id`. |
| `archived_plc_samples` | Historical readings imported from earlier recordings. |

To list machine details and modules on the same screen, open the Query Tool
on `line_pulse` and run:

```sql
SELECT m.machine_id, m.machine_code, m.machine_name, m.enabled,
       mo.module_code, mo.enabled AS module_enabled
FROM line_pulse_v2.machines AS m
LEFT JOIN line_pulse_v2.modules AS mo USING (machine_id)
ORDER BY m.machine_code, mo.display_order, mo.module_code;
```

## Manual database setup

Use Node.js 24 LTS (24.15 or later), npm, and PostgreSQL 18. From the repository
root, run `npm ci` and `npm run build`. On Windows, `check_line_pulse.bat`
performs these steps and runs offline checks.

Using a PostgreSQL administrative account, create the `line_pulse` database
and two login roles named `line_pulse_api` and `line_pulse_worker`. Give each a
separate password and restrict PostgreSQL to the intended hosts. Apply each
migration in numeric order and then apply `database/roles.sql`. Run each
migration as the database owner in one transaction, and apply it once per
database. Example using a connection already configured for the owner:

```bash
psql -X -v ON_ERROR_STOP=1 -1 -f database/migrations/001_line_pulse_v2.sql line_pulse
psql -X -v ON_ERROR_STOP=1 -1 -f database/migrations/002_partition_maintenance.sql line_pulse
psql -X -v ON_ERROR_STOP=1 -1 -f database/migrations/003_archive_and_poll_guards.sql line_pulse
psql -X -v ON_ERROR_STOP=1 -1 -f database/roles.sql line_pulse
psql -X -v ON_ERROR_STOP=1 -c 'SELECT line_pulse_v2.maintain_partitions()' line_pulse
```

Copy `.env.example` to `.env`. Set both connection strings and set
`LINE_PULSE_COLLECTOR_KEY` to a UUID specific to the collector installation.
Run `npm run line-pulse -- bootstrap-admin`, then optionally run
`npm run line-pulse -- seed-pilot` to load the bundled commissioning drafts.
Start both processes with `npm run start:local` or `start_line_pulse.bat`.
On Linux the collector can also run from the systemd example under `scripts/`.

The API listens on `127.0.0.1`. A future mobile client can use the versioned
API contract. Retrieve `/api/v1/openapi.json` with an authenticated session.
Keep one assigned worker per machine when provisioning installations.

## Technician commands

All commands use `npm run line-pulse --` from the repository root.

| Command | Purpose |
|---|---|
| `preflight` | Check the build, fixture config, and writable data directory offline. |
| `validate-config [--config FILE]` | Validate the legacy configuration used for import or technician tools. |
| `explain-requests --module OP10` | Show the exact planned request bytes offline. |
| `once --module OP10 --confirm-read-only` | Capture one bounded snapshot from the explicit config. |
| `discovery explain --module OP10` | Show the fixed discovery ranges without contacting a PLC. |
| `discovery capture --module OP10 --confirm-read-only` | Capture the fixed ranges to CSV, with bounded duration and polling. |
| `discovery analyze FILE` | Summarize a discovery CSV offline. |
| `op50-probe --confirm-read-only` | Capture the bounded OP50 register range as a CSV. |
| `compare-captures BASELINE RUNNING --output FILE` | Compare bounded captures offline, with optional HMI totals. |
| `report --machine MACHINE_001 --date YYYY-MM-DD` | Report production observations for the machine's local date. |
| `audit --machine MACHINE_001` | Show mapping versions, request plans, and stored evidence. |
| `report --database FILE --date YYYY-MM-DD` | Read an archived SQLite or sample CSV file without importing it. |
| `audit --config FILE --database FILE` | Audit the legacy configuration and optional SQLite evidence. |
| `import-archive SOURCE --database FILE --machine MACHINE_001` | Import matching SQLite samples as archived observations. Use a stable source name for replay. |

Stop the collector **process** before a CLI command that reads a PLC. The
worker and technician tools share a local lock. The checks and diagnostics
send read requests only and should use the controls team's reviewed address
plan. Configure plant-specific endpoint addresses before connecting.

## Verification and history

Run `npm test` for offline transport and queue checks. Set
`LINE_PULSE_TEST_API_DSN` and `LINE_PULSE_TEST_WORKER_DSN` to the roles on a
**separate test database with the migrations applied** to enable PostgreSQL
integration tests. Those tests create fixture machines and users.

The original SQLite and CSV files remain available for reporting and
reconciliation under `data/legacy/` on this laptop. The earlier PostgreSQL schema stays in
`database/schema.sql` for deployments that used it. The active app uses
`database/migrations/` and the `line_pulse_v2` schema.
