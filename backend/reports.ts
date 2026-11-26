import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { parse } from 'csv-parse/sync';
import { preview } from './config.js';
import { database } from './db.js';
import { legacySignals, readLegacyConfig } from './pilot.js';

type Options = { database?: string; date?: string; machine?: string; config?: string; output?: string; json?: boolean };
type Row = Record<string, unknown>;

function summarize(samples: Row[], events: Row[], errors: Row[]) {
  const names = [...new Set([...samples, ...events, ...errors].map(row => String(row.module_code ?? row.module_name)))].sort();
  return names.map(module => {
    const matches = (row: Row) => (row.module_code ?? row.module_name) === module;
    const readings = samples.filter(matches);
    const items = events.filter(matches);
    const latest = readings.at(-1);
    const count = (type: string) => items.filter(row => row.event_type === type).length;
    const increase = (type: string) => items.filter(row => row.event_type === type && Number(row.counter_delta ?? row.delta) > 0)
      .reduce((sum, row) => sum + BigInt(String(row.counter_delta ?? row.delta)), 0n).toString();
    const durations = items.map(row => row.observed_cycle_seconds).filter(value => value != null).map(Number);
    return { module, samples: readings.length, errors: errors.filter(matches).length, current_ok_total: latest?.ok_total ?? null,
      current_ng_total: latest?.ng_total ?? null, observed_ok_increase: increase('OK_COUNT_CHANGE'), observed_ng_increase: increase('NG_COUNT_CHANGE'),
      baselines: count('BASELINE_ESTABLISHED'), cycles_started: count('CYCLE_START'), cycles_completed: count('CYCLE_COMPLETE'),
      observed_cycle_seconds: durations.reduce((sum, value) => sum + value, 0),
      average_cycle_seconds: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : null };
  });
}

async function save(report: unknown, options: Options, markdown?: string) {
  const content = options.json || !markdown ? JSON.stringify(report, null, 2) : markdown;
  if (options.output) { await writeFile(options.output, content + '\n'); console.log('Saved', options.output); }
  else console.log(content);
}

export async function runReports(command: string, options: Options) {
  if (command === 'audit' && (!options.machine || options.database)) {
    const config = await readLegacyConfig(options.config);
    const sqlite = options.database && !options.database.endsWith('.csv') ? new DatabaseSync(options.database, { readOnly: true }) : undefined;
    try {
      const modules = config.modules.map(module => {
        const signals = legacySignals(config, module);
        const latest = sqlite?.prepare('SELECT * FROM raw_samples WHERE module_name=? ORDER BY id DESC LIMIT 1').get(module.name);
        const frames = latest && sqlite?.prepare('SELECT * FROM protocol_frames WHERE sample_id=? ORDER BY id').all(latest.id as number);
        return { module: module.name, endpoint: `${module.ip}:${module.port}`, unit_id: module.unit_id, signals, reads: preview(signals,module.unit_id), latest, frames };
      });
      const lines = ['# Mitsubishi FX5 read-only collection audit', '', 'Legacy configuration and evidence', ''];
      for (const item of modules) {
        lines.push(`## ${item.module}`, '', `Endpoint ${item.endpoint}, unit ${item.unit_id}`, '',
          '| Signal | Device | Function | Address | Verification |', '|---|---|---|---:|---|');
        for (const signal of item.signals) lines.push(`| ${signal.signal_code} | ${signal.plc_device} | FC0${signal.function_code} | ${signal.pdu_address} | ${signal.verification_status} |`);
        lines.push('', '### Requests', ...item.reads.map(read => `- FC0${read.function_code} address ${read.address}, quantity ${read.quantity}, bytes \`${read.request_hex}\``), '');
        if (item.latest) lines.push('### Stored observation', '', '~~~json', JSON.stringify({ sample:item.latest, frames:item.frames }, null, 2), '~~~', '');
        else lines.push('No stored observation was supplied.', '');
      }
      await save({ source: 'legacy', modules }, options, lines.join('\n'));
    } finally { sqlite?.close(); }
    return;
  }

  if (options.date && (!/^\d{4}-\d\d-\d\d$/.test(options.date) || !Number.isFinite(Date.parse(options.date))
      || new Date(options.date).toISOString().slice(0, 10) !== options.date)) throw new Error('Use --date YYYY-MM-DD');
  if (options.database) {
    const date = options.date ?? new Date().toLocaleDateString('sv-SE');
    if (options.database.endsWith('.csv')) {
      const rows = parse(await readFile(options.database), { columns: true, bom: true, skip_empty_lines: true }) as Row[];
      await save({ source: 'legacy_csv', date, modules: summarize(rows.filter(row => String(row.observed_at_local ?? row.observed_at_utc).startsWith(date)), [], []) }, options);
      return;
    }
    const sqlite = new DatabaseSync(options.database, { readOnly: true });
    try {
      const data = (table: string) => sqlite.prepare(`SELECT * FROM ${table} WHERE substr(observed_at_local,1,10)=? ORDER BY id`).all(date);
      await save({ source: 'legacy_sqlite', date, modules: summarize(data('raw_samples'), data('events'), data('collection_errors')) }, options);
    } finally { sqlite.close(); }
    return;
  }

  const pool = database();
  try {
    const selected = (await pool.query('SELECT * FROM machines WHERE machine_code=$1', [options.machine ?? 'MACHINE_001'])).rows[0];
    if (!selected) throw new Error('Machine code was not found');
    const id = selected.machine_id;
    if (command === 'audit') {
      const modules = (await pool.query(`SELECT m.module_code,v.mapping_version_id,v.version_number,v.purpose,v.published_at,
        host(e.ip_address) ip_address,e.port,e.unit_id,
        (SELECT jsonb_agg(to_jsonb(s) ORDER BY s.signal_code) FROM module_signal_mappings s WHERE s.mapping_version_id=v.mapping_version_id) signals,
        (SELECT to_jsonb(p) FROM plc_samples p WHERE p.mapping_version_id=v.mapping_version_id ORDER BY p.observed_at DESC LIMIT 1) latest
        FROM modules m JOIN module_mapping_versions v USING (module_id) JOIN plc_endpoints e USING (endpoint_id)
        WHERE m.machine_id=$1 ORDER BY m.display_order,v.version_number DESC`, [id])).rows;
      for (const item of modules) {
        item.reads = preview(item.signals, item.unit_id);
        item.frames = !item.latest ? [] : (await pool.query(`SELECT frame_number,transaction_id,function_code,start_address,quantity,
          encode(request_adu,'hex') request_hex,encode(response_adu,'hex') response_hex FROM plc_protocol_frames
          WHERE observed_at=$1 AND poll_id=$2 ORDER BY frame_number`, [item.latest.observed_at,item.latest.poll_id])).rows;
      }
      await save({ source: 'postgresql', machine: selected.machine_code, modules }, options);
      return;
    }
    const date = options.date ?? new Date().toLocaleDateString('sv-SE', { timeZone: selected.time_zone });
    const bounds = (await pool.query(`SELECT ($1::date::timestamp AT TIME ZONE $2) start_at,
      (($1::date+1)::timestamp AT TIME ZONE $2) end_at`, [date, selected.time_zone])).rows[0];
    const params = [id, bounds.start_at, bounds.end_at];
    const [samples, events, errors] = await Promise.all([
      pool.query(`SELECT m.module_code,p.ok_total,p.ng_total FROM plc_samples p JOIN modules m USING (module_id)
        JOIN module_mapping_versions v ON v.mapping_version_id=p.mapping_version_id WHERE m.machine_id=$1 AND p.observed_at>=$2 AND p.observed_at<$3
        AND v.purpose='production' ORDER BY p.observed_at,p.poll_id`, params),
      pool.query(`SELECT m.module_code,e.event_type,e.counter_delta,e.observed_cycle_seconds FROM plc_events e JOIN plc_samples p USING (observed_at,poll_id)
        JOIN modules m USING (module_id) JOIN module_mapping_versions v ON v.mapping_version_id=p.mapping_version_id
        WHERE m.machine_id=$1 AND e.observed_at>=$2 AND e.observed_at<$3 AND v.purpose='production' ORDER BY e.observed_at,e.poll_id`, params),
      pool.query(`SELECT m.module_code FROM plc_collection_errors e JOIN modules m USING (module_id)
        JOIN module_mapping_versions v ON v.mapping_version_id=e.mapping_version_id WHERE m.machine_id=$1 AND e.observed_at>=$2 AND e.observed_at<$3
        AND v.purpose='production'`, params),
    ]);
    await save({ source:'postgresql', machine:selected.machine_code, date, time_zone:selected.time_zone, modules:summarize(samples.rows,events.rows,errors.rows) }, options);
  } finally { await pool.end(); }
}
