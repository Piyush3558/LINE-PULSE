import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import pg from 'pg';
import { dataPath, projectPath } from './paths.js';
import { bootstrapAdmin, seedPilot } from './pilot.js';

const envFile = projectPath(process.env.LINE_PULSE_SETUP_ENV_FILE ?? '.env');
const credentialsFile = projectPath(process.env.LINE_PULSE_SETUP_ADMIN_FILE ?? dataPath('initial-admin.txt'));
const host = process.env.PGHOST ?? '127.0.0.1';
const port = Number(process.env.PGPORT ?? 5432);
const user = process.env.PGUSER ?? 'postgres';
const password = process.env.PGPASSWORD;

async function setup() {
  if (existsSync(envFile)) throw new Error(`Configuration already exists at ${envFile}. Use it to start Line Pulse.`);
  if (existsSync(credentialsFile)) throw new Error(`Admin credentials already exist at ${credentialsFile}. Keep them and configure the database manually.`);
  if (!password) throw new Error('Set PGPASSWORD to your local PostgreSQL administrator password or run setup_windows.bat.');
  if (host !== 'localhost' && !isIP(host)) throw new Error('Use a PostgreSQL IP address or localhost.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Set PGPORT to the PostgreSQL server port.');
  const dbName = 'line_pulse';
  const roleNames = ['line_pulse_api', 'line_pulse_worker'] as const;
  const passwords = roleNames.map(() => randomBytes(24).toString('hex'));
  const adminConfig = { host, port, user, password, connectionTimeoutMillis: 5000 };
  const server = new pg.Client({ ...adminConfig, database: 'postgres' });
  await server.connect();
  try {
    await server.query('SELECT pg_advisory_lock(1566226090)');
    const version = (await server.query('SHOW server_version_num')).rows[0].server_version_num;
    if (Number(version) < 180000) throw new Error('Install and start PostgreSQL 18 or later.');
    const roles = await server.query('SELECT rolname FROM pg_roles WHERE rolname = ANY($1)', [roleNames]);
    if (roles.rowCount) throw new Error('Line Pulse database roles already exist. Restore the matching .env or use the manual setup in README.md.');
    const existing = await server.query('SELECT 1 FROM pg_database WHERE datname=$1', [dbName]);
    if (!existing.rowCount) await server.query('CREATE DATABASE line_pulse');

    const db = new pg.Client({ ...adminConfig, database: dbName });
    await db.connect();
    try {
      await db.query('BEGIN');
      if ((await db.query("SELECT to_regnamespace('line_pulse_v2') AS existing")).rows[0].existing) {
        throw new Error('The target Line Pulse schema already exists. Use its existing configuration.');
      }
      for (const [index, role] of roleNames.entries()) {
        const { rows } = await db.query("SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', $1::text, $2::text) AS cmd", [role, passwords[index]]);
        await db.query(rows[0].cmd);
      }
      const migrations = projectPath('database', 'migrations');
      for (const file of (await readdir(migrations)).filter(name => name.endsWith('.sql')).sort()) {
        await db.query(await readFile(projectPath(migrations, file), 'utf8'));
      }
      await db.query(await readFile(projectPath('database', 'roles.sql'), 'utf8'));
      await db.query('SELECT line_pulse_v2.maintain_partitions()');
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { await db.end(); }

    const dsn = (role: string, secret: string) => `postgresql://${role}:${secret}@${isIP(host) === 6 ? '[' + host + ']' : host}:${port}/${dbName}`;
    const apiDsn = dsn(roleNames[0], passwords[0]);
    const collectorKey = randomUUID();
    await writeFile(envFile, [
      `LINE_PULSE_API_DSN=${apiDsn}`,
      `LINE_PULSE_WORKER_DSN=${dsn(roleNames[1], passwords[1])}`,
      `LINE_PULSE_COLLECTOR_KEY=${collectorKey}`,
      'LINE_PULSE_PORT=8765',
      '',
    ].join('\n'), { flag: 'wx', mode: 0o600 });
    process.env.LINE_PULSE_API_DSN = apiDsn;
    process.env.LINE_PULSE_COLLECTOR_KEY = collectorKey;
    await mkdir(dataPath(), { recursive: true });
    await bootstrapAdmin('admin', credentialsFile);
    if (process.env.LINE_PULSE_SEED_PILOT !== '0') await seedPilot();
    console.log('PostgreSQL is configured. Admin sign-in details are in', credentialsFile);
  } finally { await server.end(); }
}

try { await setup(); }
catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
