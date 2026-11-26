import { DatabaseSync } from 'node:sqlite';
import { basename } from 'node:path';
import { database, transaction } from './db.js';

export async function importArchive(path: string, machineCode: string, sourceName = basename(path)) {
  const sqlite = new DatabaseSync(path, { readOnly: true });
  const pool = database();
  try {
    const rows = sqlite.prepare('SELECT * FROM raw_samples ORDER BY id').all();
    return await transaction(pool, async client => {
      const { rows: endpoints } = await client.query(`SELECT DISTINCT m.module_id,m.module_code,e.endpoint_id,host(e.ip_address) AS ip
        FROM machines a JOIN modules m USING (machine_id) JOIN module_mapping_versions v USING (module_id)
        JOIN plc_endpoints e USING (endpoint_id) WHERE a.machine_code=$1 ORDER BY e.endpoint_id`, [machineCode]);
      if (!endpoints.length) throw new Error('Machine has no module-to-endpoint mappings');
      let imported = 0;
      let unmatched = 0;
      for (const row of rows) {
        const candidates = endpoints.filter(e => e.module_code === row.module_name && e.ip === row.module_ip);
        if (candidates.length !== 1) { unmatched++; continue; }
        const [match] = candidates;
        const result = await client.query(`INSERT INTO archived_plc_samples (module_id,endpoint_id,source_name,source_sample_id,
          observed_at,cycle_start,cycle_complete,cycle_time_raw,cycle_time_seconds,ok_total,ng_total,mapping_status,raw_values)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
        [match.module_id,match.endpoint_id,sourceName,String(row.id),row.observed_at_utc,row.cycle_start == null ? null : Boolean(row.cycle_start),
          row.cycle_complete == null ? null : Boolean(row.cycle_complete),row.cycle_time_raw,row.cycle_time_seconds,
          row.ok_total,row.ng_total,row.mapping_status,row.raw_json]);
        imported += result.rowCount ?? 0;
      }
      return { imported, unmatched, existing: rows.length - imported - unmatched };
    });
  } finally {
    sqlite.close();
    await pool.end();
  }
}
