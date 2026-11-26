import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveEvents, newPoll, queue, type Baseline, type Poll } from './collector.js';
import { planReads, readBlocks, readSnapshot, requestBytes, resolveSignal, type Read } from './plc.js';
import { legacySignals, readLegacyConfig } from './pilot.js';

test('FX5 OP10 plan matches the archived Python request bytes', async () => {
  const settings = await readLegacyConfig();
  const station = settings.modules.find(module => module.name === 'OP10')!;
  const plan = planReads(legacySignals(settings, station));
  assert.deepEqual(plan.map((read, i) => requestBytes(i + 1, 1, read).toString('hex')), [
    '000100000006010120820001', '000200000006010121040001',
    '000300000006010300100001', '000400000006010301900005',
  ]);
  assert.throws(() => requestBytes(1, 1, { function_code: 6, address: 0, quantity: 1 } as unknown as Read), /Only FC01 and FC03/);
  assert.throws(() => resolveSignal({ signal_code: 'counter', plc_device: 'D7999', data_type: 'uint32', word_order: 'low_word_first' }), /out of range/);
});

test('loopback FX5 snapshot reassembles a fragmented frame and keeps raw signed words', async () => {
  const server = createServer(socket => socket.on('data', (request: Buffer) => {
    const fn = request[7];
    const payload = fn === 1 ? Buffer.from([1,1,1]) : Buffer.from([3,4,0xff,0xfe,0xff,0xff]);
    const header = Buffer.from(request.subarray(0,7));
    header.writeUInt16BE(payload.length + 1,4);
    socket.write(header.subarray(0, 4));
    setTimeout(() => socket.write(Buffer.concat([header.subarray(4), payload])), 5);
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const signal = resolveSignal({ signal_code:'cycle_start',plc_device:'M130',data_type:'bool' });
    const word = resolveSignal({ signal_code:'signed_result',plc_device:'D16',data_type:'int32',word_order:'low_word_first' });
    const reading = await readSnapshot({ ip_address:'127.0.0.1',port:address.port,unit_id:1 }, [signal,word]);
    assert.deepEqual(reading.decoded, { cycle_start:true,signed_result:-2 });
    assert.deepEqual(reading.raw, { cycle_start:true,signed_result:[65534,65535] });
    assert.equal(reading.frames.length, 2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('an early PLC disconnect identifies the interrupted read', async () => {
  const server = createServer(socket => socket.on('data', (request: Buffer) => {
    if (request[7] === 1) {
      const header = Buffer.from(request.subarray(0, 7));
      header.writeUInt16BE(4, 4);
      socket.write(Buffer.concat([header, Buffer.from([1, 1, 1])]));
    } else {
      socket.end(request.subarray(0, 4));
    }
  }));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    await assert.rejects(readBlocks({ ip_address: '127.0.0.1', port: address.port, unit_id: 1 }, [
      { function_code: 1, address: 8322, quantity: 1 },
      { function_code: 3, address: 400, quantity: 5 },
    ]), /PLC read interrupted at request 2\/2 \(FC03, address 400, quantity 5\)/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('an interrupted snapshot reconnects once and recovers a complete reading', async () => {
  let connections = 0;
  const server = createServer(socket => {
    const attempt = ++connections;
    socket.once('data', (request: Buffer) => {
      if (attempt !== 2) { socket.end(); return; }
      const header = Buffer.from(request.subarray(0, 7));
      header.writeUInt16BE(4, 4);
      socket.end(Buffer.concat([header, Buffer.from([1, 1, 1])]));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    const endpoint = { ip_address: '127.0.0.1', port: address.port, unit_id: 1 };
    const signals = [resolveSignal({ signal_code: 'cycle_start', plc_device: 'M130', data_type: 'bool' })];
    assert.deepEqual((await readSnapshot(endpoint, signals)).decoded, { cycle_start: true });
    assert.equal(connections, 2);
    await assert.rejects(readSnapshot(endpoint, signals), /PLC read interrupted at request 1\/1/);
    assert.equal(connections, 4);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('baselines and counter decreases do not produce fabricated production increases', () => {
  const baseline: Baseline = {};
  assert.deepEqual(deriveEvents({ cycle_start:false,ok_total:100 }, baseline, 0), [{ event_type:'BASELINE_ESTABLISHED' }]);
  assert.deepEqual(deriveEvents({ cycle_start:true,ok_total:0 }, baseline, 100), [
    { event_type:'CYCLE_START' }, { event_type:'OK_COUNT_DISCONTINUITY',value:0,delta:-100 },
  ]);
  assert.deepEqual(deriveEvents({ cycle_start:false,cycle_complete:true,ok_total:1 }, baseline, 800), [
    { event_type:'CYCLE_COMPLETE',seconds:0.7 }, { event_type:'OK_COUNT_CHANGE',value:1,delta:1 },
  ]);
});

test('outbox survives reopening and preserves failure and success order', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'line-pulse-'));
  const file = join(dir, 'outbox.sqlite3');
  const failed: Poll = { ...newPoll('1','2','3'), error:'test timeout', code:'TEST' };
  const success: Poll = { ...newPoll('1','2','3'), values:{ ok_total:0 },raw:{ ok_total:[0] },scale:null,events:[],frames:[] };
  try {
    const first = queue(file);
    first.push(failed);
    first.push(success);
    first.close();
    const second = queue(file);
    assert.deepEqual(second.peek(), failed);
    second.remove(failed.poll_id);
    assert.deepEqual(second.peek(), success);
    assert.equal(second.count('1'),1);
    second.close();
  } finally { await rm(dir, { recursive:true,force:true }); }
});
