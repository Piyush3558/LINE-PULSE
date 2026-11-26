import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { database, transaction } from './db.js';
import { dataPath } from './paths.js';

export async function checkDatabase() {
  for (const [name, dsn] of [['API', process.env.LINE_PULSE_API_DSN], ['Collector', process.env.LINE_PULSE_WORKER_DSN]]) {
    if (!dsn) throw new Error(`Missing the ${name} PostgreSQL connection string`);
    const pool = database(dsn);
    try {
      const { rows } = await pool.query(`SELECT current_database() AS db,inet_server_addr() AS host,
        (SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()) AS tls,
        (SELECT count(*) FROM machines) AS machines`);
      const { db, host, tls, machines } = rows[0];
      if (process.env.LINE_PULSE_DB_CA_FILE && !tls) throw new Error('The shared database connection did not negotiate TLS');
      console.log(`${name}: ${db} via ${host ?? 'local socket'}${tls ? ' (TLS)' : ''}. ${machines} machine(s).`);
    } finally { await pool.end(); }
  }
}

export async function assignThisCollector(machineCode: string) {
  const key = process.env.LINE_PULSE_COLLECTOR_KEY;
  if (!key) throw new Error('Configure the local collector installation ID first');
  const pool = database();
  try {
    await transaction(pool, async db => {
      const { rows } = await db.query(`SELECT m.machine_id,m.collector_key,s.status
        FROM machines m LEFT JOIN collector_state s USING (machine_id)
        WHERE m.machine_code=$1 FOR UPDATE OF m`, [machineCode.toUpperCase()]);
      const machine = rows[0];
      if (!machine) throw new Error(`Machine ${machineCode} was not found in the shared database`);
      if (machine.collector_key === key) return;
      if (machine.status === 'running') throw new Error('Stop collection on the current laptop before moving this machine');
      const commands = await db.query(`SELECT 1 FROM collector_commands
        WHERE machine_id=$1 AND status IN ('pending','running') AND expires_at>now() LIMIT 1`, [machine.machine_id]);
      if (commands.rowCount) throw new Error('Wait for the current collector command to finish before moving this machine');
      await db.query('UPDATE machines SET collector_key=$2 WHERE machine_id=$1', [machine.machine_id,key]);
    });
    console.log(`${machineCode.toUpperCase()} is assigned to this laptop.`);
  } finally { await pool.end(); }
}

export async function makeWindowsProfile(host: string, machineCode: string) {
  if (isIP(host) !== 4) throw new Error('Enter the database host IPv4 address used on the certificate');
  const certificate = dataPath('pg-tls', 'ca.crt');
  await readFile(certificate);
  const port = process.env.LINE_PULSE_SHARED_PG_PORT ?? '55432';
  const remote = (value?: string) => {
    if (!value) throw new Error('Configure both local PostgreSQL roles in .env before creating a Windows profile');
    const dsn = new URL(value);
    if (!dsn.username || !dsn.password) throw new Error('The PostgreSQL app role needs a username and password');
    return `postgresql://${dsn.username}:${dsn.password}@${host}:${port}${dsn.pathname}`;
  };
  const destination = dataPath('windows-shared', randomUUID().slice(0, 8));
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await copyFile(certificate, `${destination}/line-pulse-db-ca.pem`, constants.COPYFILE_EXCL);
  await writeFile(`${destination}/.env`, [
    `LINE_PULSE_API_DSN=${remote(process.env.LINE_PULSE_API_DSN)}`,
    `LINE_PULSE_WORKER_DSN=${remote(process.env.LINE_PULSE_WORKER_DSN)}`,
    'LINE_PULSE_DB_CA_FILE=line-pulse-db-ca.pem',
    `LINE_PULSE_COLLECTOR_KEY=${randomUUID()}`,
    `LINE_PULSE_SETUP_MACHINE_CODE=${machineCode.toUpperCase()}`,
    'LINE_PULSE_PORT=8765',
    '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  return destination;
}
