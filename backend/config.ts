import { isIP } from 'node:net';
import type { Pool, PoolClient } from 'pg';
import { planReads, requestBytes, resolveSignal, type Signal } from './plc.js';

export async function timezone(value: string, db: Pool | PoolClient) {
  const input = value.trim().toLowerCase() === 'asia/calcutta' ? 'Asia/Kolkata' : value.trim();
  let canonical: string;
  try { canonical = new Intl.DateTimeFormat('en', { timeZone: input }).resolvedOptions().timeZone; }
  catch { throw new HttpError(400, 'Enter a valid IANA time zone, such as Asia/Kolkata'); }
  const { rows } = await db.query(`SELECT name FROM pg_timezone_names WHERE lower(name) IN (lower($1),lower($2))
    ORDER BY (lower(name)=lower($1)) DESC LIMIT 1`, [input,canonical]);
  if (!rows[0]) throw new HttpError(400, 'Enter an IANA time zone available on the database server');
  return String(rows[0].name);
}

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}

export function validAddress(address: string) {
  if (!isIP(address)) throw new HttpError(400, 'Enter an IPv4 or IPv6 host address');
  if (['0.0.0.0', '::'].includes(address)) throw new HttpError(400, 'Enter the PLC host address');
  return address;
}

export async function insertSignals(client: PoolClient, versionId: string, signals: Signal[]) {
  for (const signal of signals) {
    await client.query(`INSERT INTO module_signal_mappings
      (mapping_version_id,signal_code,plc_device,function_code,pdu_address,data_type,word_order,scale_factor,engineering_unit,verification_status,evidence_reference)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [versionId, signal.signal_code, signal.plc_device, signal.function_code, signal.pdu_address, signal.data_type,
      signal.word_order, signal.scale_factor, signal.engineering_unit, signal.verification_status, signal.evidence_reference]);
  }
}

export function validateSignals(input: Parameters<typeof resolveSignal>[0][]) {
  try {
    const signals = input.map(resolveSignal);
    if (new Set(signals.map(signal => signal.signal_code)).size !== signals.length) throw new Error('Signal codes must be unique');
    for (const code of ['cycle_start', 'cycle_complete']) {
      if (!signals.some(signal => signal.signal_code === code)) throw new Error(`Add the ${code} bit`);
    }
    return signals;
  } catch (error) {
    throw new HttpError(400, (error as Error).message);
  }
}

export function preview(signals: Signal[], unitId: number) {
  return planReads(signals).map((read, index) => ({ ...read, request_hex: requestBytes(index + 1, unitId, read).toString('hex') }));
}
