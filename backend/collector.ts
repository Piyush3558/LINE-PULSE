import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Pool } from 'pg';
import { transaction } from './db.js';
import type { Frame } from './plc.js';

export type Values = Record<string, number | boolean>;
type Event = { event_type: string; value?: number; delta?: number; seconds?: number };
export type Baseline = { previous?: Values; started?: number };
export type Poll = {
  observed_at: string;
  poll_id: string;
  module_id: string;
  mapping_version_id: string;
  machine_id: string;
} & (
  { error: string; code: string } |
  { values: Values; scale: string | null; raw: Record<string, boolean | number[]>; events: Event[]; frames: Frame[] }
);

export function newPoll(machineId: string, moduleId: string, version: string) {
  return { machine_id: machineId, module_id: moduleId, mapping_version_id: version, observed_at: new Date().toISOString(), poll_id: randomUUID() };
}

export function deriveEvents(values: Values, state: Baseline, now: number): Event[] {
  const previous = state.previous;
  state.previous = values;
  if (!previous) return [{ event_type: 'BASELINE_ESTABLISHED' }];
  const events: Event[] = [];
  if (values.cycle_start && !previous.cycle_start) {
    state.started = now;
    events.push({ event_type: 'CYCLE_START' });
  }
  if (values.cycle_complete && !previous.cycle_complete) {
    events.push({ event_type: 'CYCLE_COMPLETE', seconds: state.started === undefined ? undefined : Math.round(now - state.started) / 1000 });
    state.started = undefined;
  }
  for (const [key, prefix] of [['ok_total', 'OK'], ['ng_total', 'NG']] as const) {
    const value = values[key];
    const prior = previous[key];
    if (typeof value !== 'number' || typeof prior !== 'number' || value === prior) continue;
    events.push({ event_type: value < prior ? `${prefix}_COUNT_DISCONTINUITY` : `${prefix}_COUNT_CHANGE`, value, delta: value - prior });
  }
  return events;
}

export async function storePoll(pool: Pool, poll: Poll) {
  const key = [poll.observed_at, poll.poll_id, poll.module_id, poll.mapping_version_id];
  if ('error' in poll) {
    await pool.query(`INSERT INTO plc_collection_errors (observed_at,poll_id,module_id,mapping_version_id,error_code,error_message)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (observed_at,poll_id) DO NOTHING`, [...key, poll.code, poll.error]);
    return;
  }
  await transaction(pool, async client => {
    const v = poll.values;
    const inserted = await client.query(`INSERT INTO plc_samples
      (observed_at,poll_id,module_id,mapping_version_id,cycle_start,cycle_complete,cycle_time_raw,cycle_time_seconds,ok_total,ng_total,raw_values)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$7::bigint::numeric*$8::numeric,$9,$10,$11)
      ON CONFLICT (observed_at,poll_id) DO NOTHING`,
    [...key, v.cycle_start ?? null, v.cycle_complete ?? null, v.cycle_time ?? null, poll.scale, v.ok_total ?? null, v.ng_total ?? null, JSON.stringify(poll.raw)]);
    if (!inserted.rowCount) return;
    for (const event of poll.events) {
      await client.query(`INSERT INTO plc_events (observed_at,poll_id,event_type,counter_value,counter_delta,observed_cycle_seconds)
        VALUES ($1,$2,$3,$4,$5,$6)`,
      [...key.slice(0, 2), event.event_type, event.value ?? null, event.delta ?? null, event.seconds ?? null]);
    }
    for (const [index, frame] of poll.frames.entries()) {
      await client.query(`INSERT INTO plc_protocol_frames (observed_at,poll_id,frame_number,transaction_id,function_code,start_address,quantity,request_adu,response_adu)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [...key.slice(0, 2), index + 1, frame.transaction_id, frame.function_code, frame.address, frame.quantity,
        Buffer.from(frame.request, 'hex'), Buffer.from(frame.response, 'hex')]);
    }
  });
}

export function queue(path: string) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const sqlite = new DatabaseSync(path);
  sqlite.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS outbox (position INTEGER PRIMARY KEY, poll_id TEXT NOT NULL UNIQUE, machine_id TEXT NOT NULL, payload TEXT NOT NULL) STRICT;`);
  return {
    push(poll: Poll) {
      sqlite.prepare('INSERT INTO outbox (poll_id,machine_id,payload) VALUES (?,?,?)').run(poll.poll_id, poll.machine_id, JSON.stringify(poll));
    },
    peek() {
      const row = sqlite.prepare('SELECT payload FROM outbox ORDER BY position LIMIT 1').get();
      return row ? JSON.parse(String(row.payload)) as Poll : undefined;
    },
    remove(pollId: string) { sqlite.prepare('DELETE FROM outbox WHERE poll_id=?').run(pollId); },
    count(machineId?: string) {
      return Number((machineId === undefined
        ? sqlite.prepare('SELECT count(*) AS count FROM outbox').get()
        : sqlite.prepare('SELECT count(*) AS count FROM outbox WHERE machine_id=?').get(machineId))?.count);
    },
    close() { sqlite.close(); },
  };
}

export async function localCollectorLock() {
  const lock = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    lock.once('error', reject);
    lock.listen(Number(process.env.LINE_PULSE_COLLECTOR_LOCK_PORT ?? 8766), '127.0.0.1', resolve);
  });
  return lock;
}
