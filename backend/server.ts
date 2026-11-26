import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import { csrfMatches, CSRF, passwordMatches, hashPassword, SESSION, token, tokenHash, type User } from './auth.js';
import { HttpError, insertSignals, preview, timezone, validAddress, validateSignals } from './config.js';
import { database, transaction } from './db.js';
import { csv, getHistory } from './history.js';
import type { Signal } from './plc.js';
import { schemas as s, type Body } from './schemas.js';
import { frontendDist } from './paths.js';

export async function createServer(pool = database(), staticRoot = frontendDist) {
  const app = Fastify({ logger: true, bodyLimit: 128 * 1024, ajv: { customOptions: { removeAdditional: false } } });
  const port = Number(process.env.LINE_PULSE_PORT ?? 8765);
  const frontendDevOrigin = `http://127.0.0.1:${process.env.LINE_PULSE_FRONTEND_PORT ?? 5173}`;
  const origins = new Set([`http://127.0.0.1:${port}`]);
  if (process.env.LINE_PULSE_DEV === '1') origins.add(frontendDevOrigin);
  const loginAttempts = new Map<string, { expires: number; count: number }>();
  const cookieOptions = { path: '/', sameSite: 'strict' as const, maxAge: 12 * 3600 };
  app.decorateRequest('user', null);
  await app.register(cookie);
  await app.register(swagger, { openapi: { info: { title: 'Line Pulse API', version: '1.0.0' } } });

  app.addHook('onRequest', async request => {
    if (!request.url.startsWith('/api/v1/')) return;
    const writing = !['GET', 'HEAD'].includes(request.method);
    if (writing && (!request.headers.origin || !origins.has(request.headers.origin))) {
      const message = request.headers.origin === frontendDevOrigin
        ? `This API is running in normal mode. Open Line Pulse on port ${port} or start the backend with npm run dev.`
        : 'Open Line Pulse using its local address';
      throw new HttpError(403, message);
    }
    if (['/api/v1/health', '/api/v1/login'].includes(request.url.split('?')[0])) return;
    const session = request.cookies[SESSION];
    if (!session) throw new HttpError(401, 'Sign in to Line Pulse');
    const { rows } = await pool.query<User>(`SELECT u.user_id,u.username,u.role FROM user_sessions s JOIN users u USING (user_id)
      WHERE s.session_token_hash=$1 AND s.expires_at>now() AND u.enabled`, [tokenHash(session)]);
    if (!rows[0]) throw new HttpError(401, 'Your session has expired');
    request.user = rows[0];
    if (writing && !csrfMatches(request)) throw new HttpError(403, 'Refresh the page and try again');
  });
  app.addHook('onSend', async (request, reply) => {
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });

  app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, request, reply) => {
    if (error instanceof HttpError || error.statusCode && error.statusCode < 500) {
      return reply.code(error.statusCode ?? 400).send({ message: error.message });
    }
    if (error.code === '23505') return reply.code(409).send({ message: 'A record with these details already exists' });
    if (error.code === '23503') return reply.code(409).send({ message: 'The related record is missing or belongs to another machine' });
    request.log.error(error);
    return reply.code(500).send({ message: 'Line Pulse could not complete the request' });
  });

  function allow(user: User | null, ...roles: User['role'][]) {
    if (!user || !roles.includes(user.role)) throw new HttpError(403, 'Your account cannot perform this action');
    return user;
  }

  async function machine(id: string) {
    const { rows } = await pool.query('SELECT * FROM machines WHERE machine_id=$1', [id]);
    if (!rows[0]) throw new HttpError(404, 'Machine not found');
    return rows[0];
  }

  app.get('/api/v1/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok', database: 'postgresql' };
  });
  app.post<{ Body: Body<'login'> }>('/api/v1/login', { schema: { body: s.login } }, async (request, reply) => {
    const now = Date.now();
    for (const [key, value] of loginAttempts) if (value.expires <= now) loginAttempts.delete(key);
    const attempt = loginAttempts.get(request.ip) ?? { expires: now + 60000, count: 0 };
    if (attempt.count >= 10) throw new HttpError(429, 'Too many sign-in attempts. Try again in a minute.');
    attempt.count++;
    loginAttempts.set(request.ip, attempt);
    const { rows } = await pool.query<User & { password_hash: string }>(
      'SELECT user_id,username,role,password_hash FROM users WHERE username=$1 AND enabled', [request.body.username.trim().toLowerCase()]);
    const user = rows[0];
    if (!await passwordMatches(request.body.password, user?.password_hash)) throw new HttpError(401, 'Check your username and password');
    const session = token();
    await transaction(pool, async client => {
      await client.query('DELETE FROM user_sessions WHERE expires_at<=now() OR session_token_hash=$1',
        [tokenHash(request.cookies[SESSION] ?? '')]);
      await client.query("INSERT INTO user_sessions VALUES ($1,$2,now(),now()+interval '12 hours')", [tokenHash(session), user.user_id]);
    });
    loginAttempts.delete(request.ip);
    reply.setCookie(SESSION, session, { ...cookieOptions, httpOnly: true }).setCookie(CSRF, token(), cookieOptions);
    return { user_id: user.user_id, username: user.username, role: user.role };
  });
  app.get('/api/v1/session', async request => request.user);
  app.post('/api/v1/logout', async (request, reply) => {
    await pool.query('DELETE FROM user_sessions WHERE session_token_hash=$1', [tokenHash(request.cookies[SESSION]!)]);
    return reply.clearCookie(SESSION, { path: '/' }).clearCookie(CSRF, { path: '/' }).code(204).send();
  });
  app.get('/api/v1/openapi.json', async () => app.swagger());
  app.get('/api/v1/users', async request => {
    allow(request.user, 'admin');
    return (await pool.query('SELECT user_id,username,role,enabled,created_at FROM users ORDER BY username')).rows;
  });
  app.post<{ Body: Body<'user'> }>('/api/v1/users', { schema: { body: s.user } }, async (request, reply) => {
    allow(request.user, 'admin');
    const { username, password, role } = request.body;
    const { rows } = await pool.query('INSERT INTO users (username,password_hash,role) VALUES ($1,$2,$3) RETURNING user_id,username,role,enabled',
      [username.toLowerCase(), await hashPassword(password), role]);
    return reply.code(201).send(rows[0]);
  });
  app.patch<{ Params: Body<'userId'>; Body: Body<'userEnabled'> }>('/api/v1/users/:userId', { schema: { params: s.userId, body: s.userEnabled } }, async request => {
    const current = allow(request.user, 'admin');
    if (current.user_id === request.params.userId && !request.body.enabled) throw new HttpError(409, 'You cannot disable your own account');
    return transaction(pool, async client => {
      const { rows } = await client.query('UPDATE users SET enabled=$2 WHERE user_id=$1 RETURNING user_id,username,role,enabled', [request.params.userId, request.body.enabled]);
      if (!rows[0]) throw new HttpError(404, 'User not found');
      if (!request.body.enabled) await client.query('DELETE FROM user_sessions WHERE user_id=$1', [request.params.userId]);
      return rows[0];
    });
  });

  const base = '/api/v1/machines';
  const scoped = `${base}/:machineId`;
  const modulePath = `${scoped}/modules/:moduleId`;
  const mappings = `${modulePath}/mappings`;
  app.get(base, async () => (await pool.query('SELECT * FROM machines ORDER BY machine_code')).rows);
  app.post<{ Body: Body<'machine'> }>(base, { schema: { body: s.machine } }, async (request, reply) => {
    allow(request.user, 'admin');
    const b = request.body;
    const { rows } = await pool.query(`INSERT INTO machines (machine_code,machine_name,time_zone,poll_interval_seconds,collector_key,enabled)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [b.machine_code.toUpperCase(), b.machine_name.trim(), await timezone(b.time_zone, pool), b.poll_interval_seconds, b.collector_key ?? null, b.enabled]);
    return reply.code(201).send(rows[0]);
  });
  app.get<{ Params: Body<'machineId'> }>(scoped, { schema: { params: s.machineId } }, request => machine(request.params.machineId));
  app.put<{ Params: Body<'machineId'>; Body: Body<'machine'> }>(scoped, { schema: { params: s.machineId, body: s.machine } }, async request => {
    allow(request.user, 'admin');
    const b = request.body;
    const current = await machine(request.params.machineId);
    if (b.machine_code.toUpperCase() !== current.machine_code) throw new HttpError(400, 'The machine code is permanent');
    const { rows } = await pool.query('UPDATE machines SET machine_name=$2,time_zone=$3,poll_interval_seconds=$4,collector_key=$5,enabled=$6 WHERE machine_id=$1 RETURNING *',
      [request.params.machineId, b.machine_name.trim(), await timezone(b.time_zone, pool), b.poll_interval_seconds, b.collector_key ?? null, b.enabled]);
    return rows[0];
  });
  app.get<{ Params: Body<'machineId'> }>(`${scoped}/modules`, { schema: { params: s.machineId } }, async request => {
    await machine(request.params.machineId);
    return (await pool.query('SELECT * FROM modules WHERE machine_id=$1 ORDER BY display_order,module_code', [request.params.machineId])).rows;
  });
  app.post<{ Params: Body<'machineId'>; Body: Body<'module'> }>(`${scoped}/modules`, { schema: { params: s.machineId, body: s.module } }, async (request, reply) => {
    allow(request.user, 'admin');
    const b = request.body;
    await machine(request.params.machineId);
    const { rows } = await pool.query('INSERT INTO modules (machine_id,module_code,display_order,enabled) VALUES ($1,$2,$3,$4) RETURNING *',
      [request.params.machineId, b.module_code.toUpperCase(), b.display_order, b.enabled]);
    return reply.code(201).send(rows[0]);
  });
  app.put<{ Params: Body<'moduleId'>; Body: Body<'module'> }>(modulePath, { schema: { params: s.moduleId, body: s.module } }, async request => {
    allow(request.user, 'admin');
    const { machineId, moduleId } = request.params;
    const b = request.body;
    const { rows } = await pool.query('UPDATE modules SET module_code=$3,display_order=$4,enabled=$5 WHERE machine_id=$1 AND module_id=$2 RETURNING *',
      [machineId, moduleId, b.module_code.toUpperCase(), b.display_order, b.enabled]);
    if (!rows[0]) throw new HttpError(404, 'Module not found');
    return rows[0];
  });
  app.get<{ Params: Body<'machineId'> }>(`${scoped}/endpoints`, { schema: { params: s.machineId } }, async request => {
    allow(request.user, 'admin');
    await machine(request.params.machineId);
    return (await pool.query('SELECT endpoint_id,machine_id,host(ip_address) AS ip_address,port,unit_id FROM plc_endpoints WHERE machine_id=$1 ORDER BY endpoint_id', [request.params.machineId])).rows;
  });
  app.post<{ Params: Body<'machineId'>; Body: Body<'endpoint'> }>(`${scoped}/endpoints`, { schema: { params: s.machineId, body: s.endpoint } }, async (request, reply) => {
    allow(request.user, 'admin');
    const b = request.body;
    await machine(request.params.machineId);
    const { rows } = await pool.query('INSERT INTO plc_endpoints (machine_id,ip_address,port,unit_id) VALUES ($1,$2,$3,$4) RETURNING endpoint_id,machine_id,host(ip_address) AS ip_address,port,unit_id',
      [request.params.machineId, validAddress(b.ip_address), b.port, b.unit_id]);
    return reply.code(201).send(rows[0]);
  });

  app.get<{ Params: Body<'moduleId'> }>(mappings, { schema: { params: s.moduleId } }, async request => {
    allow(request.user, 'admin');
    const { machineId, moduleId } = request.params;
    const { rows } = await pool.query(`SELECT v.*,host(e.ip_address) AS ip_address,e.port,e.unit_id,
      COALESCE((SELECT jsonb_agg(to_jsonb(s) || jsonb_build_object('scale_factor',s.scale_factor::text) ORDER BY s.signal_code)
        FROM module_signal_mappings s WHERE s.mapping_version_id=v.mapping_version_id),'[]') AS signals
      FROM module_mapping_versions v JOIN plc_endpoints e USING (endpoint_id)
      WHERE v.machine_id=$1 AND v.module_id=$2 ORDER BY v.version_number DESC`, [machineId, moduleId]);
    return rows.map(row => ({ ...row, reads: preview(row.signals, row.unit_id) }));
  });
  app.post<{ Params: Body<'moduleId'>; Body: Body<'mapping'> }>(`${mappings}/preview`, { schema: { params: s.moduleId, body: s.mapping } }, async request => {
    allow(request.user, 'admin');
    const { machineId, moduleId } = request.params;
    const { rows } = await pool.query(`SELECT e.unit_id FROM plc_endpoints e JOIN modules m USING (machine_id)
      WHERE e.machine_id=$1 AND m.module_id=$2 AND e.endpoint_id=$3`, [machineId, moduleId, request.body.endpoint_id]);
    if (!rows[0]) throw new HttpError(404, 'Module or endpoint not found for this machine');
    const signals = validateSignals(request.body.signals);
    return { signals, reads: preview(signals, rows[0].unit_id) };
  });
  app.post<{ Params: Body<'moduleId'>; Body: Body<'mapping'> }>(mappings, { schema: { params: s.moduleId, body: s.mapping } }, async (request, reply) => {
    allow(request.user, 'admin');
    const { machineId, moduleId } = request.params;
    const b = request.body;
    const signals = validateSignals(b.signals);
    const draft = await transaction(pool, async client => {
      const module = await client.query('SELECT module_id FROM modules WHERE machine_id=$1 AND module_id=$2 FOR UPDATE', [machineId, moduleId]);
      if (!module.rowCount) throw new HttpError(404, 'Module not found');
      const { rows } = await client.query(`INSERT INTO module_mapping_versions (machine_id,module_id,endpoint_id,purpose,version_number)
        VALUES ($1,$2,$3,$4,(SELECT COALESCE(MAX(version_number),0)+1 FROM module_mapping_versions WHERE module_id=$2)) RETURNING *`,
      [machineId, moduleId, b.endpoint_id, b.purpose]);
      await insertSignals(client, rows[0].mapping_version_id, signals);
      return rows[0];
    });
    return reply.code(201).send(draft);
  });
  app.put<{ Params: Body<'versionId'>; Body: Body<'mapping'> }>(`${mappings}/:versionId`, { schema: { params: s.versionId, body: s.mapping } }, async request => {
    allow(request.user, 'admin');
    const { machineId, moduleId, versionId } = request.params;
    const b = request.body;
    const signals = validateSignals(b.signals);
    return transaction(pool, async client => {
      const { rows } = await client.query(`UPDATE module_mapping_versions SET endpoint_id=$4,purpose=$5
        WHERE machine_id=$1 AND module_id=$2 AND mapping_version_id=$3 AND published_at IS NULL RETURNING *`,
      [machineId, moduleId, versionId, b.endpoint_id, b.purpose]);
      if (!rows[0]) throw new HttpError(409, 'Only drafts can be edited');
      await client.query('DELETE FROM module_signal_mappings WHERE mapping_version_id=$1', [versionId]);
      await insertSignals(client, versionId, signals);
      return rows[0];
    });
  });
  app.post<{ Params: Body<'versionId'> }>(`${mappings}/:versionId/publish`, { schema: { params: s.versionId } }, async request => {
    const user = allow(request.user, 'admin');
    const { machineId, moduleId, versionId } = request.params;
    return transaction(pool, async client => {
      await client.query('SELECT module_id FROM modules WHERE machine_id=$1 AND module_id=$2 FOR UPDATE', [machineId, moduleId]);
      const { rows } = await client.query(`SELECT * FROM module_mapping_versions WHERE machine_id=$1 AND module_id=$2
        AND mapping_version_id=$3 FOR UPDATE`, [machineId, moduleId, versionId]);
      if (!rows[0]) throw new HttpError(404, 'Mapping not found');
      if (rows[0].published_at) throw new HttpError(409, 'Mapping already published. Start a new version to make changes.');
      const signals = (await client.query<Signal>('SELECT * FROM module_signal_mappings WHERE mapping_version_id=$1', [versionId])).rows;
      validateSignals(signals);
      if (rows[0].purpose === 'production' && signals.some(signal => signal.verification_status !== 'verified' || !signal.evidence_reference)) {
        throw new HttpError(400, 'Verify every production signal and add an evidence reference before publication');
      }
      await client.query('UPDATE module_mapping_versions SET published_at=now(),published_by=$2 WHERE mapping_version_id=$1', [versionId, user.user_id]);
      await client.query('UPDATE modules SET active_mapping_version_id=$2 WHERE module_id=$1', [moduleId, versionId]);
      return { mapping_version_id: versionId, active: true };
    });
  });

  app.get<{ Params: Body<'machineId'> }>(`${scoped}/status`, { schema: { params: s.machineId } }, async request => {
    const { machineId } = request.params;
    const selected = await machine(machineId);
    const collector = (await pool.query(`SELECT *,heartbeat_at < now()-interval '20 seconds' AS stale
      FROM collector_state WHERE machine_id=$1`, [machineId])).rows[0] ?? null;
    const { rows } = await pool.query(`SELECT m.module_id,m.module_code,m.display_order,m.enabled,m.active_mapping_version_id,
      v.purpose, COALESCE(last_sample.record,archive.record) AS record, last_error.error, last_sample.record IS NULL OR
      (last_sample.record->>'mapping_version_id') IS DISTINCT FROM m.active_mapping_version_id::text OR
      (last_sample.record->>'observed_at')::timestamptz < now()-make_interval(secs=>GREATEST($2::integer*3,20)) AS stale
      FROM modules m LEFT JOIN module_mapping_versions v ON v.mapping_version_id=m.active_mapping_version_id
      LEFT JOIN LATERAL (SELECT jsonb_build_object('observed_at',s.observed_at,'cycle_start',s.cycle_start,'cycle_complete',s.cycle_complete,
        'cycle_time_seconds',s.cycle_time_seconds::text,'cycle_time_raw',s.cycle_time_raw::text,'ok_total',s.ok_total::text,'ng_total',s.ng_total::text,
        'mapping_version_id',s.mapping_version_id::text,'purpose',sv.purpose) AS record
        FROM plc_samples s JOIN module_mapping_versions sv ON sv.mapping_version_id=s.mapping_version_id
        WHERE s.module_id=m.module_id ORDER BY s.observed_at DESC,s.poll_id DESC LIMIT 1) last_sample ON true
      LEFT JOIN LATERAL (SELECT jsonb_build_object('observed_at',a.observed_at,'cycle_start',a.cycle_start,'cycle_complete',a.cycle_complete,
        'cycle_time_seconds',a.cycle_time_seconds::text,'cycle_time_raw',a.cycle_time_raw::text,'ok_total',a.ok_total::text,'ng_total',a.ng_total::text,
        'purpose','archived','source_name',a.source_name) AS record
        FROM archived_plc_samples a WHERE a.module_id=m.module_id AND last_sample.record IS NULL
        ORDER BY a.observed_at DESC,a.archive_id DESC LIMIT 1) archive ON true
      LEFT JOIN LATERAL (SELECT jsonb_build_object('observed_at',e.observed_at,'message',e.error_message) AS error
        FROM plc_collection_errors e WHERE e.module_id=m.module_id ORDER BY e.observed_at DESC LIMIT 1) last_error ON true
      WHERE m.machine_id=$1 ORDER BY m.display_order,m.module_code`, [machineId, selected.poll_interval_seconds]);
    return { machine: selected, collector, modules: rows };
  });
  app.get<{ Params: Body<'machineId'>; Querystring: Body<'archiveQuery'> }>(`${scoped}/archive`, { schema: { params: s.machineId, querystring: s.archiveQuery } }, async request => {
    const { machineId } = request.params;
    await machine(machineId);
    const { rows } = await pool.query(`SELECT a.archive_id,a.observed_at,m.module_code,a.source_name,a.mapping_status,
      a.ok_total,a.ng_total,a.cycle_time_raw,a.cycle_time_seconds FROM archived_plc_samples a JOIN modules m USING (module_id)
      WHERE m.machine_id=$1 AND ($2::bigint IS NULL OR m.module_id=$2)
        AND ($3::bigint IS NULL OR (a.observed_at,a.archive_id) < (SELECT c.observed_at,c.archive_id FROM archived_plc_samples c
          JOIN modules cm USING (module_id) WHERE c.archive_id=$3 AND cm.machine_id=$1))
      ORDER BY a.observed_at DESC,a.archive_id DESC LIMIT 101`, [machineId, request.query.module_id ?? null, request.query.cursor ?? null]);
    const page = rows.slice(0, 100);
    return { rows: page, next_cursor: rows.length > 100 ? page.at(-1)?.archive_id : null };
  });
  for (const kind of ['samples', 'events'] as const) {
    app.get<{ Params: Body<'machineId'>; Querystring: Body<'history'> }>(`${scoped}/${kind}`, { schema: { params: s.machineId, querystring: s.history } }, async request => {
      await machine(request.params.machineId);
      return getHistory(pool, request.params.machineId, kind, request.query);
    });
  }
  app.get<{ Params: Body<'exportKind'>; Querystring: Body<'history'> }>(`${scoped}/exports/:kind`, { schema: { params: s.exportKind, querystring: s.history } }, async (request, reply) => {
    const { machineId, kind } = request.params;
    await machine(machineId);
    const { rows } = await getHistory(pool, machineId, kind, request.query, true);
    const columns = ['observed_at', 'poll_id', 'module_id', 'module_code', 'purpose', 'mapping_version_id',
      ...(kind === 'events' ? ['event_type', 'counter_value', 'counter_delta', 'observed_cycle_seconds', 'details']
        : ['stored_at', 'cycle_start', 'cycle_complete', 'cycle_time_raw', 'cycle_time_seconds', 'ok_total', 'ng_total', 'raw_values'])];
    return reply.type('text/csv; charset=utf-8').header('Content-Disposition', `attachment; filename="line-pulse-${kind}.csv"`).send(csv(rows, columns));
  });
  app.post<{ Params: Body<'machineId'>; Body: Body<'command'> }>(`${scoped}/collector-commands`, { schema: { params: s.machineId, body: s.command } }, async (request, reply) => {
    const user = allow(request.user, 'admin', 'operator');
    const selected = await machine(request.params.machineId);
    if (!selected.collector_key) throw new HttpError(409, 'Assign a collector to this machine first');
    if (request.body.action === 'start' && !selected.enabled) throw new HttpError(409, 'Enable this machine in Setup before starting collection');
    const { rows } = await pool.query(`INSERT INTO collector_commands (command_id,machine_id,action,status,requested_by,expires_at)
      VALUES ($1,$2,$3,'pending',$4,now()+interval '60 seconds') RETURNING *`,
    [randomUUID(), request.params.machineId, request.body.action, user.user_id]);
    return reply.code(202).send(rows[0]);
  });
  app.get<{ Params: Body<'commandId'> }>(`${scoped}/collector-commands/:commandId`, { schema: { params: s.commandId } }, async request => {
    const { machineId, commandId } = request.params;
    const { rows } = await pool.query(`SELECT *,CASE WHEN status IN ('pending','running') AND expires_at<now()
      THEN 'expired' ELSE status END AS status FROM collector_commands WHERE machine_id=$1 AND command_id=$2`, [machineId, commandId]);
    if (!rows[0]) throw new HttpError(404, 'Command not found');
    return rows[0];
  });

  if (existsSync(staticRoot)) {
    await app.register(fastifyStatic, { root: staticRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.method === 'GET' && !request.url.startsWith('/api/') && request.headers.accept?.includes('text/html')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ message: 'Page not found' });
    });
  }
  app.addHook('onClose', async () => pool.end());
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await createServer();
  await app.listen({ port: Number(process.env.LINE_PULSE_PORT ?? 8765), host: '127.0.0.1' });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
}
