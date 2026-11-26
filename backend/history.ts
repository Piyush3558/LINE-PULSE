import type { Pool } from 'pg';
import { HttpError } from './config.js';
import type { Body } from './schemas.js';

export async function getHistory(pool: Pool, machineId: string, kind: 'samples' | 'events', query: Body<'history'>, exportCsv = false) {
  const to = query.to ?? new Date().toISOString();
  if (!/^\d{4}-\d\d-\d\dT.*Z$/.test(to) || !Number.isFinite(Date.parse(to))) throw new HttpError(400, 'Enter a valid UTC end time');
  const from = query.from ?? new Date(Date.parse(to) - 86400000).toISOString();
  if (!/^\d{4}-\d\d-\d\dT.*Z$/.test(from) || !Number.isFinite(Date.parse(from)) || Date.parse(to) <= Date.parse(from)
      || Date.parse(to) - Date.parse(from) > 31 * 86400000) throw new HttpError(400, 'Enter a UTC date range of up to 31 days');

  let cursor: string[] = [];
  if (query.cursor) {
    const value = Buffer.from(query.cursor, 'base64url').toString().split('|');
    if (value.length !== 3 || !Number.isFinite(Date.parse(value[0])) || !/^[0-9a-f-]{36}$/i.test(value[1])
        || !/^[A-Z_]*$/.test(value[2])) throw new HttpError(400, 'Invalid history cursor');
    cursor = value;
  }

  const event = kind === 'events';
  const time = event ? 'e.observed_at' : 's.observed_at';
  const poll = event ? 'e.poll_id' : 's.poll_id';
  const fromSql = event
    ? 'plc_events e JOIN plc_samples s USING (observed_at,poll_id)'
    : 'plc_samples s';
  const extra = event
    ? 'e.event_type,e.counter_value,e.counter_delta,e.observed_cycle_seconds,e.details'
    : 's.stored_at,s.cycle_start,s.cycle_complete,s.cycle_time_raw,s.cycle_time_seconds,s.ok_total,s.ng_total,s.raw_values';
  const limit = exportCsv ? 50000 : query.limit ?? 50;
  const result = await pool.query(`SELECT ${time} AS observed_at,
      to_char(${time}, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_time,
      ${poll} AS poll_id, m.module_id,m.module_code,v.purpose,s.mapping_version_id,${extra}
    FROM ${fromSql} JOIN modules m USING (module_id) JOIN module_mapping_versions v ON v.mapping_version_id=s.mapping_version_id
    WHERE m.machine_id=$1 AND ${time}>=$2 AND ${time}<$3
      AND ($4::bigint IS NULL OR m.module_id=$4)
      AND ($5::text='all' OR v.purpose=$5)
      AND ($6::timestamptz IS NULL OR (${time},${poll},${event ? 'e.event_type' : "''::text"}) < ($6,$7::uuid,$8::text))
    ORDER BY ${time} DESC,${poll} DESC${event ? ',e.event_type DESC' : ''}
    LIMIT $9`,
  [machineId, from, to, query.module_id ?? null, query.purpose ?? 'all', cursor[0] ?? null, cursor[1] ?? null, cursor[2] ?? '', limit + 1]);
  if (exportCsv && result.rows.length > limit) throw new HttpError(400, 'Export exceeds 50,000 rows. Choose a shorter date range or one module.');
  const rows = result.rows.slice(0, limit);
  const tail = rows.at(-1);
  const next_cursor = result.rows.length > limit && tail
    ? Buffer.from([tail.cursor_time, tail.poll_id, tail.event_type ?? ''].join('|')).toString('base64url')
    : null;
  return { rows: rows.map(({ cursor_time, ...row }) => row), next_cursor };
}

export function csv(rows: Record<string, unknown>[], columns = Object.keys(rows[0] ?? {})) {
  const cell = (value: unknown) => {
    if (value == null) return '';
    if (value instanceof Date) return value.toISOString();
    const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return `"${str.replaceAll('"', '""')}"`;
  };
  return [columns.join(','), ...rows.map(row => columns.map(key => cell(row[key])).join(','))].join('\r\n') + '\r\n';
}
