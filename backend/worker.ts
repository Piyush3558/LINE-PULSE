import { setTimeout as delay } from 'node:timers/promises';
import { database } from './db.js';
import { dataPath, projectPath } from './paths.js';
import { deriveEvents, localCollectorLock, newPoll, queue, storePoll, type Baseline, type Poll } from './collector.js';
import { checkEndpoint, readSnapshot, type Endpoint, type Signal } from './plc.js';

type Machine = { machine_id: string; enabled: boolean; poll_interval_seconds: number };
type Module = Endpoint & { module_id: string; mapping_version_id: string; purpose: string; signals: Signal[] };
type Configuration = Machine & { modules: Module[] };
type Runtime = { running: boolean; nextAt: number; versions: Map<string, { id: string; baseline: Baseline }>; lastUpload?: string };

const key = process.env.LINE_PULSE_COLLECTOR_KEY;
if (!key) throw new Error('Set LINE_PULSE_COLLECTOR_KEY to the assigned installation UUID');
const lock = await localCollectorLock();
const pool = database(process.env.LINE_PULSE_WORKER_DSN);
const outbox = queue(process.env.LINE_PULSE_QUEUE ? projectPath(process.env.LINE_PULSE_QUEUE) : dataPath('outbox.sqlite3'));
const runtimes = new Map<string, Runtime>();
let configs: Configuration[] = [];
let blocked = false;
let stopping = false;
let offline = false;
let nextPartitionCheck = 0;
let observationClock = { databaseMs: Date.now(), monotonicMs: performance.now() };

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopping = true; });

function observedTime() {
  // Keep estimating database time during an outage without changing queued timestamps.
  return new Date(observationClock.databaseMs + performance.now() - observationClock.monotonicMs).toISOString();
}

async function refresh() {
  const queryStarted = performance.now();
  const { rows } = await pool.query<Configuration & { database_time: Date }>(`SELECT a.machine_id,a.enabled,a.poll_interval_seconds,
    statement_timestamp() AS database_time,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('module_id',m.module_id::text,'mapping_version_id',v.mapping_version_id::text,
      'purpose',v.purpose,'ip_address',host(e.ip_address),'port',e.port,'unit_id',e.unit_id,
      'signals',(SELECT jsonb_agg(to_jsonb(s)||jsonb_build_object('scale_factor',s.scale_factor::text) ORDER BY s.signal_code)
        FROM module_signal_mappings s WHERE s.mapping_version_id=v.mapping_version_id)) ORDER BY m.display_order,m.module_code)
      FROM modules m JOIN module_mapping_versions v ON v.mapping_version_id=m.active_mapping_version_id
      JOIN plc_endpoints e USING (endpoint_id)
      WHERE m.machine_id=a.machine_id AND m.enabled AND v.published_at IS NOT NULL),'[]') AS modules
    FROM machines a WHERE a.collector_key=$1 ORDER BY a.machine_id`, [key]);
  if (rows[0]) observationClock = { databaseMs: rows[0].database_time.getTime(), monotonicMs: (queryStarted + performance.now()) / 2 };
  for (const machine of rows) {
    if (!runtimes.has(machine.machine_id)) {
      runtimes.set(machine.machine_id, { running: false, nextAt: 0, versions: new Map() });
      await pool.query(`UPDATE collector_commands SET status='failed',finished_at=now(),result='{"message":"Collector restarted while command was running"}'
        WHERE machine_id=$1 AND status='running'`, [machine.machine_id]);
    }
    const runtime = runtimes.get(machine.machine_id)!;
    const enabledModules = new Set(machine.modules.map(module => module.module_id));
    for (const moduleId of runtime.versions.keys()) {
      if (!enabledModules.has(moduleId)) runtime.versions.delete(moduleId);
    }
  }
  for (const id of runtimes.keys()) if (!rows.some(machine => machine.machine_id === id)) runtimes.delete(id);
  configs = rows;
}

async function connections(configuration: Configuration, deadline: number) {
  const endpoints = new Map<string, Endpoint>();
  for (const module of configuration.modules) endpoints.set(`${module.ip_address}:${module.port}`, module);
  const results = [];
  for (const endpoint of endpoints.values()) {
    if (stopping || Date.now() >= deadline) break;
    try {
      await checkEndpoint(endpoint, Math.min(2000, Math.max(1, deadline - Date.now())));
      results.push({ ip_address: endpoint.ip_address, port: endpoint.port, online: true });
    } catch (error) {
      results.push({ ip_address: endpoint.ip_address, port: endpoint.port, online: false, error: (error as Error).message });
    }
  }
  return results;
}

async function commands(configuration: Configuration, runtime: Runtime) {
  const { rows } = await pool.query(`UPDATE collector_commands SET status='running' WHERE command_id=(
    SELECT command_id FROM collector_commands WHERE machine_id=$1 AND status='pending' AND expires_at>now()
    ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`, [configuration.machine_id]);
  const command = rows[0];
  if (!command) return;
  let status = 'completed';
  let result: object;
  try {
    if (command.action === 'stop') {
      runtime.running = false;
      runtime.versions.clear();
      result = { message: 'Collection stopped' };
    } else if (command.action === 'start' && runtime.running) {
      result = { message: 'Collection is already running' };
    } else {
      if (command.action === 'start' && (blocked || !configuration.enabled || !configuration.modules.length)) {
        throw new Error('Enable the machine and at least one module with a published mapping. Check local queue health.');
      }
      const endpoints = await connections(configuration, Date.parse(command.expires_at));
      if (Date.now() >= Date.parse(command.expires_at)) throw new Error('Connection check expired');
      const online = endpoints.filter(endpoint => endpoint.online).length;
      if (command.action === 'start' && online === 0) throw new Error('No configured PLC endpoint responded');
      if (command.action === 'start') {
        runtime.running = true;
        runtime.nextAt = 0;
      }
      result = { message: command.action === 'start' ? 'Collection started' : `${online} of ${endpoints.length} configured endpoints reachable`, endpoints };
    }
  } catch (error) {
    status = 'failed';
    result = { message: (error as Error).message };
  }
  await pool.query('UPDATE collector_commands SET status=$2,finished_at=now(),result=$3 WHERE command_id=$1', [command.command_id, status, JSON.stringify(result)]);
}

async function pollMachine(configuration: Configuration, runtime: Runtime) {
  for (const module of configuration.modules) {
    if (stopping) return;
    const meta = newPoll(configuration.machine_id, module.module_id, module.mapping_version_id);
    let version = runtime.versions.get(module.module_id);
    if (version?.id !== module.mapping_version_id) {
      version = { id: module.mapping_version_id, baseline: {} };
      runtime.versions.set(module.module_id, version);
    }
    let outcome: Poll;
    try {
      const sample = await readSnapshot(module, module.signals);
      outcome = { ...meta, observed_at: observedTime(), values: sample.decoded, raw: sample.raw,
        scale: module.signals.find(signal => signal.signal_code === 'cycle_time')?.scale_factor ?? null,
        events: deriveEvents(sample.decoded, version.baseline, performance.now()),
        frames: module.purpose === 'commissioning' || process.env.LINE_PULSE_CAPTURE_FRAMES === '1' ? sample.frames : [] };
    } catch (error) {
      version.baseline = {};
      outcome = { ...meta, observed_at: observedTime(), code: (error as NodeJS.ErrnoException).code ?? 'PLC_READ', error: (error as Error).message };
    }
    try { outbox.push(outcome); }
    catch (error) {
      blocked = true;
      for (const state of runtimes.values()) { state.running = false; state.versions.clear(); }
      console.error('Collection blocked because the local outbox could not be written', error);
      return;
    }
  }
}

async function upload() {
  for (let sent = 0; sent < 100; sent++) {
    const poll = outbox.peek();
    if (!poll) return;
    await storePoll(pool, poll);
    outbox.remove(poll.poll_id);
    const runtime = runtimes.get(poll.machine_id);
    if (runtime) runtime.lastUpload = observedTime();
  }
}

console.log('Line Pulse collector ready. Collection starts only when requested.');
try {
  while (!stopping) {
    try {
      await refresh();
      if (performance.now() >= nextPartitionCheck) {
        await pool.query('SELECT maintain_partitions()');
        nextPartitionCheck = performance.now() + 12 * 3600000;
      }
      for (const config of configs) await commands(config, runtimes.get(config.machine_id)!);
      await upload();
      for (const config of configs) {
        const runtime = runtimes.get(config.machine_id)!;
        const pending = outbox.count(config.machine_id);
        if (pending >= 2000) console.warn(`Machine ${config.machine_id} has ${pending} pending polls`);
        await pool.query(`INSERT INTO collector_state (machine_id,status,heartbeat_at,last_upload_at,pending_polls)
          VALUES ($1,$2,now(),$3,$4) ON CONFLICT (machine_id) DO UPDATE SET status=EXCLUDED.status,
          heartbeat_at=EXCLUDED.heartbeat_at,last_upload_at=COALESCE(EXCLUDED.last_upload_at,collector_state.last_upload_at),
          pending_polls=EXCLUDED.pending_polls`,
        [config.machine_id, blocked ? 'blocked' : runtime.running && config.enabled ? 'running' : 'stopped', runtime.lastUpload ?? null, pending]);
      }
      if (offline) console.log('PostgreSQL available again');
      offline = false;
    } catch (error) {
      if (!offline) console.error('PostgreSQL communication failed. Cached collection can continue in the local outbox.', error);
      offline = true;
    }
    for (const config of configs) {
      const runtime = runtimes.get(config.machine_id);
      if (!runtime) continue;
      if (!config.enabled || !config.modules.length) {
        runtime.running = false;
        runtime.versions.clear();
      }
      if (stopping || blocked || !runtime.running || performance.now() < runtime.nextAt) continue;
      runtime.nextAt = performance.now() + 1000 * config.poll_interval_seconds;
      await pollMachine(config, runtime);
      if (offline && outbox.count(config.machine_id) >= 2000) console.warn(`Machine ${config.machine_id} outbox has ${outbox.count(config.machine_id)} pending polls`);
    }
    await delay(500);
  }
} finally {
  await pool.end();
  outbox.close();
  lock.close();
}
