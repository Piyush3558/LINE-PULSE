import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { hashPassword } from './auth.js';
import { insertSignals, timezone, validateSignals } from './config.js';
import { database, transaction } from './db.js';
import type { SignalInput } from './plc.js';
import { defaultConfig } from './paths.js';

export type LegacyConfig = {
  poll_interval_seconds: number;
  modules: Array<{ name: string; ip: string; port: number; unit_id: number; signal_profile: string; enabled: boolean }>;
  signal_profiles: Record<string, { cycle_time_scale_seconds: number | null; signals: Record<string, {
    device: string; data_type: SignalInput['data_type']; source_status: string; word_order?: SignalInput['word_order'];
  }> }>;
};
export const readLegacyConfig = async (path = defaultConfig) => JSON.parse(await readFile(path, 'utf8')) as LegacyConfig;

export function legacySignals(config: LegacyConfig, module: LegacyConfig['modules'][number]) {
  const profile = config.signal_profiles[module.signal_profile];
  if (!profile) throw new Error(`Missing signal profile for ${module.name}`);
  return validateSignals(Object.entries(profile.signals).map(([signal_code, entry]) => ({
    signal_code, plc_device: entry.device, data_type: entry.data_type,
    verification_status: entry.source_status, word_order: entry.word_order ?? 'high_word_first',
    scale_factor: signal_code === 'cycle_time' && profile.cycle_time_scale_seconds != null ? String(profile.cycle_time_scale_seconds) : null,
    engineering_unit: signal_code === 'cycle_time' && profile.cycle_time_scale_seconds != null ? 's' : null,
  })));
}

export async function seedPilot(configPath?: string) {
  const config = await readLegacyConfig(configPath);
  const pool = database();
  try {
    return await transaction(pool, async client => {
      const { rows } = await client.query(`INSERT INTO machines
        (machine_code,machine_name,time_zone,poll_interval_seconds,collector_key)
        VALUES ('MACHINE_001',$1,$2,$3,$4) ON CONFLICT (machine_code) DO NOTHING RETURNING machine_id`,
      [process.env.LINE_PULSE_PILOT_NAME ?? 'Machine 1', await timezone(process.env.LINE_PULSE_PILOT_TIME_ZONE ?? 'Asia/Kolkata', client),
        config.poll_interval_seconds, process.env.LINE_PULSE_COLLECTOR_KEY ?? null]);
      if (!rows[0]) return false;
      const machineId = rows[0].machine_id;
      for (const [index, module] of config.modules.entries()) {
        await client.query('INSERT INTO plc_endpoints (machine_id,ip_address,port,unit_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
          [machineId, module.ip, module.port, module.unit_id]);
        const endpoint = (await client.query('SELECT endpoint_id FROM plc_endpoints WHERE machine_id=$1 AND ip_address=$2 AND port=$3 AND unit_id=$4',
          [machineId, module.ip, module.port, module.unit_id])).rows[0];
        const station = (await client.query('INSERT INTO modules (machine_id,module_code,display_order) VALUES ($1,$2,$3) RETURNING module_id',
          [machineId, module.name, (index + 1) * 10])).rows[0];
        const version = (await client.query(`INSERT INTO module_mapping_versions (machine_id,module_id,endpoint_id,version_number,purpose)
          VALUES ($1,$2,$3,1,'commissioning') RETURNING mapping_version_id`, [machineId, station.module_id, endpoint.endpoint_id])).rows[0];
        await insertSignals(client, version.mapping_version_id, legacySignals(config, module));
      }
      return true;
    });
  } finally { await pool.end(); }
}

export async function bootstrapAdmin(username: string, credentialsPath: string) {
  if (!/^[a-z0-9_.-]{1,80}$/.test(username)) throw new Error('Enter a lowercase username');
  const pool = database();
  try {
    const password = randomBytes(24).toString('base64url');
    await transaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(1566226002)');
      const count = (await client.query('SELECT count(*) AS count FROM users')).rows[0].count;
      if (count !== '0') throw new Error('Bootstrap is only available before creating the first user');
      await client.query("INSERT INTO users (username,password_hash,role) VALUES ($1,$2,'admin')", [username, await hashPassword(password)]);
      await writeFile(credentialsPath, `Username: ${username}\nPassword: ${password}\n`, { flag: 'wx', mode: 0o600 });
    });
  } finally { await pool.end(); }
}
