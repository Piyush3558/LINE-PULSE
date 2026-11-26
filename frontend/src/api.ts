import type { Body } from '../../backend/schemas.js';
export type Account = { user_id: string; username: string; role: 'admin' | 'operator' | 'viewer'; enabled?: boolean };
export type Machine = Body<'machine'> & { machine_id: string };
export type Module = Body<'module'> & { module_id: string; active_mapping_version_id: string | null };
export type Endpoint = Body<'endpoint'> & { endpoint_id: string };
export type MappingInput = Body<'mapping'>;
export type Read = { function_code: number; address: number; quantity: number; request_hex: string };
export type Mapping = MappingInput & { mapping_version_id: string; version_number: number; published_at: string | null; reads: Read[] };
export type ModuleStatus = Module & {
  stale: boolean;
  purpose: 'production' | 'commissioning' | null;
  record: { observed_at: string; cycle_start: boolean | null; cycle_complete: boolean | null; ok_total: string | null; ng_total: string | null; cycle_time_raw: string | null; cycle_time_seconds: string | null; purpose: string } | null;
  error: { observed_at: string; message: string } | null;
};
export type Status = { machine: Machine; collector: { heartbeat_at: string; status: string; stale: boolean; pending_polls: number } | null; modules: ModuleStatus[] };
export type History = { rows: Record<string, string | null>[]; next_cursor: string | null };
export type Command = { command_id: string; status: string; result?: { message: string } };
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const csrf = document.cookie.split('; ').find(part => part.startsWith('line_pulse_csrf='))?.split('=')[1];
  const response = await fetch('/api/v1' + path, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(csrf && method !== 'GET' ? { 'x-csrf-token': decodeURIComponent(csrf) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(response.status, error.message ?? `Request failed (${response.status})`);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export function displayTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium', timeZone }).format(new Date(value));
}
