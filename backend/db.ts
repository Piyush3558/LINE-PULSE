import { readFileSync } from 'node:fs';
import { checkServerIdentity } from 'node:tls';
import pg, { type PoolClient } from 'pg';
import { projectPath } from './paths.js';

export function database(connectionString = process.env.LINE_PULSE_API_DSN) {
  const certificateFile = process.env.LINE_PULSE_DB_CA_FILE;
  let tls: pg.PoolConfig = {};
  if (certificateFile) {
    if (!connectionString) throw new Error('Set a PostgreSQL connection string for the shared database');
    const address = new URL(connectionString);
    if (['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'host'].some(key => address.searchParams.has(key))) {
      throw new Error('The shared database connection needs its host in the DSN and TLS configured through LINE_PULSE_DB_CA_FILE');
    }
    const host = address.hostname.replace(/^\[|\]$/g, '');
    tls = {
      ssl: {
        ca: readFileSync(projectPath(certificateFile)),
        rejectUnauthorized: true,
        checkServerIdentity: (_serverName, certificate) => checkServerIdentity(host, certificate),
      },
      enableChannelBinding: true,
    };
  }
  const pool = new pg.Pool({
    connectionString,
    ...tls,
    options: '-c search_path=line_pulse_v2,pg_catalog -c timezone=UTC',
    connectionTimeoutMillis: 3000,
    statement_timeout: 10000,
    max: 8,
  });
  pool.on('error', error => console.error('Idle PostgreSQL connection closed', error.message));
  return pool;
}

export async function transaction<T>(pool: pg.Pool, fn: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
