import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { hashPassword } from './auth.js';
import { newPoll, storePoll, type Poll } from './collector.js';
import { database } from './db.js';
import { createServer } from './server.js';

const dsn = process.env.LINE_PULSE_TEST_API_DSN;
const workerDsn = process.env.LINE_PULSE_TEST_WORKER_DSN;
const origin = 'http://127.0.0.1:8765';

test('PostgreSQL-backed setup, mapping activation, telemetry replay, and permissions', { skip: !dsn || !workerDsn }, async () => {
  const pool = database(dsn);
  const worker = database(workerDsn);
  const app = await createServer(pool, 'no-static-test');
  const suffix = randomUUID().slice(0, 8);
  try {
    const password = randomUUID();
    const username = 'admin-' + suffix;
    await pool.query("INSERT INTO users(username,password_hash,role) VALUES ($1,$2,'admin')", [username, await hashPassword(password)]);
    const login = await app.inject({ method:'POST',url:'/api/v1/login',headers:{ origin },payload:{ username,password } });
    assert.equal(login.statusCode,200,login.body);
    const auth = (response: typeof login) => ({ origin, cookie:response.cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '),
      'x-csrf-token':response.cookies.find(cookie => cookie.name === 'line_pulse_csrf')!.value });
    const headers = auth(login);
    const createMachine = async (index: number) => {
      const response = await app.inject({ method:'POST',url:'/api/v1/machines',headers,
        payload:{ machine_code:`TEST_${suffix}_${index}`,machine_name:`Test ${index}`,time_zone:'Asia/Kolkata',poll_interval_seconds:5,enabled:false } });
      assert.equal(response.statusCode,201,response.body);
      assert.equal(response.json().time_zone,'Asia/Kolkata');
      return '/api/v1/machines/' + response.json().machine_id;
    };
    const first = await createMachine(1);
    const second = await createMachine(2);
    const addModule = async (path: string, code = 'OP10') => {
      const response = await app.inject({ method:'POST',url:path + '/modules',headers,payload:{ module_code:code,display_order:10,enabled:true } });
      assert.equal(response.statusCode,201,response.body);
      return String(response.json().module_id);
    };
    const moduleId = await addModule(first);
    const secondId = await addModule(second);
    const siblingId = await addModule(first, 'OP20');
    const target = await app.inject({ method:'POST',url:first + '/endpoints',headers,payload:{ ip_address:'127.0.0.1',port:1502,unit_id:1 } });
    assert.equal(target.statusCode,201,target.body);
    const endpointId = target.json().endpoint_id;
    const draft = { endpoint_id:endpointId,purpose:'commissioning',signals:[
      { signal_code:'cycle_start',plc_device:'M130',data_type:'bool',scale_factor:null },
      { signal_code:'cycle_complete',plc_device:'M260',data_type:'bool' },
      { signal_code:'cycle_time',plc_device:'D16',data_type:'uint16',scale_factor:'0.01' },
    ] };
    const mappings = (path: string, id: string) => `${path}/modules/${id}/mappings`;
    const preview = await app.inject({ method:'POST',url:mappings(first,moduleId)+'/preview',headers,payload:draft });
    assert.equal(preview.statusCode,200,preview.body);
    assert.equal(preview.json().signals[0].scale_factor,null);
    const rejected = await app.inject({ method:'POST',url:mappings(second,secondId),headers,payload:draft });
    assert.equal(rejected.statusCode,409,rejected.body);
    const addVersion = async (id: string, purpose: string) => {
      const response = await app.inject({ method:'POST',url:mappings(first,id),headers,payload:{ ...draft,purpose } });
      assert.equal(response.statusCode,201,response.body);
      return String(response.json().mapping_version_id);
    };
    const versionId = await addVersion(moduleId,'commissioning');
    const unpublishedProduction = await addVersion(siblingId,'production');
    const rejectPublication = await app.inject({ method:'POST',url:`${mappings(first,siblingId)}/${unpublishedProduction}/publish`,headers });
    assert.equal(rejectPublication.statusCode,400,rejectPublication.body);
    const publish = await app.inject({ method:'POST',url:`${mappings(first,moduleId)}/${versionId}/publish`,headers });
    assert.equal(publish.statusCode,200,publish.body);
    await assert.rejects(pool.query('UPDATE module_mapping_versions SET purpose=$1 WHERE mapping_version_id=$2',['production',versionId]),/immutable/);
    await worker.query('SELECT maintain_partitions()');
    const machineId = first.split('/').at(-1)!;
    const poll: Poll = { ...newPoll(machineId,moduleId,versionId),values:{ cycle_time:78,cycle_start:true,ok_total:0 },raw:{ cycle_time:[78],cycle_start:true,ok_total:[0] },
      scale:'0.01',events:[{ event_type:'BASELINE_ESTABLISHED' }],frames:[
        { address:8322,function_code:1,quantity:1,transaction_id:1,request:'000100000006010120820001',response:'00010000000401010101' },
      ] };
    await storePoll(worker,poll);
    await storePoll(worker,poll);
    await assert.rejects(storePoll(worker,{ ...poll,error:'unexpected',code:'TEST' }),/already has a sample/);
    const errorPoll = { ...newPoll(machineId,moduleId,versionId),error:'Fixture timeout',code:'TEST' };
    await storePoll(worker,errorPoll);
    await storePoll(worker,errorPoll);
    const history = await app.inject({ method:'GET',url:first + '/samples',headers });
    assert.equal(history.statusCode,200,history.body);
    assert.equal(history.json().rows.length,1);
    assert.equal(history.json().rows[0].cycle_time_seconds,'0.78');
    assert.equal(history.json().rows[0].ok_total,'0');
    const otherHistory = await app.inject({ method:'GET',url:second + '/samples',headers });
    assert.deepEqual(otherHistory.json().rows,[]);
    const events = await app.inject({ method:'GET',url:first + '/events',headers });
    assert.equal(events.statusCode,200,events.body);
    assert.equal(events.json().rows.length,1);
    assert.equal((await pool.query('SELECT count(*) FROM plc_protocol_frames WHERE poll_id=$1',[poll.poll_id])).rows[0].count,'1');
    const upcoming = (await pool.query("SELECT date_trunc('month',now()) + interval '1 month' AS at")).rows[0].at.toISOString();
    await storePoll(worker,{ ...poll,poll_id:randomUUID(),observed_at:upcoming });
    const viewname = 'viewer-' + suffix;
    const added = await app.inject({ method:'POST',url:'/api/v1/users',headers,payload:{ username:viewname,password,role:'viewer' } });
    assert.equal(added.statusCode,201,added.body);
    const viewer = await app.inject({ method:'POST',url:'/api/v1/login',headers:{ origin },payload:{ username:viewname,password } });
    const view = auth(viewer);
    assert.equal((await app.inject({ method:'GET',url:first+'/status',headers:view })).statusCode,200);
    assert.equal((await app.inject({ method:'POST',url:first+'/collector-commands',headers:view,payload:{ action:'check' } })).statusCode,403);
    assert.equal((await app.inject({ method:'GET',url:first+'/exports/samples',headers })).statusCode,200);
  } finally { await Promise.all([app.close(),worker.end()]); }
});
