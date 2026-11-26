import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export type Endpoint = { ip_address: string; port: number; unit_id: number };
export type Signal = {
  signal_code: string;
  plc_device: string;
  function_code: 1 | 3;
  pdu_address: number;
  data_type: 'bool' | 'uint16' | 'int16' | 'uint32' | 'int32';
  word_order: 'high_word_first' | 'low_word_first' | null;
  scale_factor: string | null;
  engineering_unit: string | null;
  verification_status: string;
  evidence_reference: string | null;
};
export type SignalInput = Pick<Signal, 'signal_code' | 'plc_device' | 'data_type'> & Partial<Signal>;
export type Read = { function_code: 1 | 3; address: number; quantity: number };
export type Frame = Read & { transaction_id: number; request: string; response: string };

class InterruptedRead extends Error {}

export function resolveSignal(input: SignalInput): Signal {
  const device = input.plc_device.trim().toUpperCase();
  const match = /^([MD])(\d+)$/.exec(device);
  const kind = match?.[1];
  const number = Number(match?.[2]);
  const type = input.data_type;
  const scale = input.scale_factor?.trim() || null;
  const width = type === 'uint32' || type === 'int32' ? 2 : 1;
  if (!match || number + width - 1 > (kind === 'M' ? 7679 : 7999)) throw new Error(`FX5 device out of range: ${device}`);
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(input.signal_code)) throw new Error('Invalid signal code');
  if (!(kind === 'M' ? type === 'bool' : ['uint16', 'int16', 'uint32', 'int32'].includes(type))) {
    throw new Error(`Invalid type for ${device}`);
  }
  if (['cycle_start', 'cycle_complete'].includes(input.signal_code) && type !== 'bool') throw new Error('Start and completion must be bits');
  if (['ok_total', 'ng_total'].includes(input.signal_code) && !['uint16', 'uint32'].includes(type)) throw new Error('Counters must be unsigned registers');
  if (input.signal_code === 'cycle_time' && type === 'bool') throw new Error('Cycle time must be a register');
  if (width === 2 && !['high_word_first', 'low_word_first'].includes(input.word_order ?? '')) throw new Error('Select a word order for each 32-bit signal');
  if (scale !== null && (!/^\d{1,12}(\.\d{1,12})?$/.test(scale) || Number(scale) <= 0 || type === 'bool')) {
    throw new Error('Scale must be a positive decimal for a register');
  }
  if (input.signal_code === 'cycle_time' && scale && input.engineering_unit && input.engineering_unit.trim() !== 's') {
    throw new Error('The cycle time scale must convert the raw value to seconds');
  }
  return {
    signal_code: input.signal_code,
    plc_device: device,
    function_code: kind === 'M' ? 1 : 3,
    pdu_address: kind === 'M' ? 0x2000 + number : number,
    data_type: type,
    word_order: width === 2 ? input.word_order! : null,
    scale_factor: scale,
    engineering_unit: input.signal_code === 'cycle_time' && scale ? 's' : input.engineering_unit?.trim() || null,
    verification_status: input.verification_status ?? 'candidate',
    evidence_reference: input.evidence_reference?.trim() || null,
  };
}

export function planReads(signals: Signal[]): Read[] {
  const coils = new Set<number>();
  const registers = new Set<number>();
  for (const signal of signals) {
    if (signal.function_code === 1) coils.add(signal.pdu_address);
    else {
      registers.add(signal.pdu_address);
      if (signal.word_order) registers.add(signal.pdu_address + 1);
    }
  }
  const reads: Read[] = [...coils].sort((a, b) => a - b).map(address => ({ function_code: 1, address, quantity: 1 }));
  let block: Read | undefined;
  for (const address of [...registers].sort((a, b) => a - b)) {
    if (!block || address - (block.address + block.quantity - 1) > 4 || address - block.address >= 125) {
      block = { function_code: 3, address, quantity: 1 };
      reads.push(block);
    } else block.quantity = address - block.address + 1;
  }
  return reads;
}

export function requestBytes(transactionId: number, unitId: number, read: Read) {
  const { function_code: fn, address, quantity } = read;
  if (fn !== 1 && fn !== 3) throw new Error('Only FC01 and FC03 reads are permitted');
  if (!Number.isInteger(address) || !Number.isInteger(quantity) || !Number.isInteger(transactionId) || !Number.isInteger(unitId)
      || address < 0 || quantity < 1 || quantity > (fn === 1 ? 2000 : 125) || address + quantity > 65536
      || transactionId < 0 || transactionId > 65535 || unitId < 0 || unitId > 255) throw new Error('Invalid Modbus request bounds');
  const bytes = Buffer.alloc(12);
  bytes.writeUInt16BE(transactionId, 0);
  bytes.writeUInt16BE(6, 4);
  bytes[6] = unitId;
  bytes[7] = fn;
  bytes.writeUInt16BE(address, 8);
  bytes.writeUInt16BE(quantity, 10);
  return bytes;
}

export async function checkEndpoint(endpoint: Endpoint, timeout = 2000) {
  const socket = createConnection({ host: endpoint.ip_address, port: endpoint.port });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.setTimeout(timeout);
      socket.once('timeout', () => reject(new Error('PLC connection timed out')));
      socket.once('error', reject);
      socket.once('connect', resolve);
    });
  } finally {
    socket.destroy();
  }
}

export async function readBlocks(endpoint: Endpoint, reads: Read[], timeout = 2000) {
  const frames: Frame[] = [];
  const values: Array<Array<boolean | number>> = [];
  const requests = reads.map((read, index) => requestBytes(index + 1, endpoint.unit_id, read));
  const socket = createConnection({ host: endpoint.ip_address, port: endpoint.port });
  let buffer: Buffer = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  let failure: Error | undefined;
  let closed = false;
  const fail = (error: Error) => { failure ??= error; wake?.(); };
  socket.on('error', fail);
  socket.on('close', () => { closed = true; wake?.(); });
  socket.on('data', (chunk: Buffer) => {
    if (buffer.length + chunk.length > 260) {
      fail(new Error('Unexpected Modbus response size'));
      socket.destroy();
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    wake?.();
  });

  async function receive(length: number, deadline: number) {
    while (buffer.length < length) {
      if (failure) throw failure;
      if (closed) {
        const read = reads[frames.length];
        const fn = read.function_code === 1 ? 'FC01' : 'FC03';
        throw new InterruptedRead(`PLC read interrupted at request ${frames.length + 1}/${reads.length} (${fn}, address ${read.address}, quantity ${read.quantity})`);
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('PLC response timed out')), Math.max(0, deadline - performance.now()));
        wake = () => { clearTimeout(timer); resolve(); };
      }).finally(() => { wake = undefined; });
    }
    const bytes = buffer.subarray(0, length);
    buffer = buffer.subarray(length);
    return bytes;
  }

  try {
    for (const [index, read] of reads.entries()) {
      const request = requests[index];
      socket.write(request);
      const deadline = performance.now() + timeout;
      const header = await receive(7, deadline);
      const length = header.readUInt16BE(4);
      if (header.readUInt16BE(0) !== index + 1 || header.readUInt16BE(2) !== 0 || header[6] !== endpoint.unit_id
          || length < 3 || length > 254) throw new Error('Invalid Modbus response header');
      const pdu = await receive(length - 1, deadline);
      if (pdu[0] === (read.function_code | 0x80) && pdu.length === 2) throw new Error(`Modbus exception ${pdu[1]}`);
      const size = read.function_code === 1 ? Math.ceil(read.quantity / 8) : read.quantity * 2;
      if (pdu[0] !== read.function_code || pdu[1] !== size || pdu.length !== size + 2 || buffer.length !== 0) {
        throw new Error('Invalid Modbus response payload');
      }
      frames.push({ ...read, transaction_id: index + 1, request: request.toString('hex'), response: Buffer.concat([header, pdu]).toString('hex') });
      values.push(Array.from({ length: read.quantity }, (_, offset) => read.function_code === 1
        ? Boolean(pdu[2 + Math.floor(offset / 8)] & (1 << (offset % 8)))
        : pdu.readUInt16BE(2 + offset * 2)));
    }
    return { frames, values };
  } finally {
    socket.destroy();
  }
}

export async function readSnapshot(endpoint: Endpoint, signals: Signal[]) {
  const reads = planReads(signals);
  const { frames, values } = await readBlocks(endpoint, reads).catch(async (error: NodeJS.ErrnoException) => {
    if (!(error instanceof InterruptedRead) && error.code !== 'ECONNRESET' && error.code !== 'EPIPE') throw error;
    await delay(150);
    return readBlocks(endpoint, reads);
  });
  const raw: Record<string, boolean | number[]> = {};
  const decoded: Record<string, boolean | number> = {};
  const locations = new Map<string, boolean | number>();
  reads.forEach((read, index) => values[index].forEach((value, offset) => locations.set(`${read.function_code}:${read.address + offset}`, value)));
  for (const signal of signals) {
    const first = locations.get(`${signal.function_code}:${signal.pdu_address}`)!;
    if (signal.function_code === 1) {
      raw[signal.signal_code] = Boolean(first);
      decoded[signal.signal_code] = Boolean(first);
      continue;
    }
    const words = [Number(first)];
    if (signal.word_order) words.push(Number(locations.get(`3:${signal.pdu_address + 1}`)!));
    const ordered = signal.word_order === 'low_word_first' ? words.toReversed() : words;
    const unsigned = ordered.reduce((value, word) => value * 65536 + word, 0);
    const modulus = 2 ** (16 * words.length);
    raw[signal.signal_code] = words;
    decoded[signal.signal_code] = signal.data_type.startsWith('int') && unsigned >= modulus / 2 ? unsigned - modulus : unsigned;
  }
  return { frames, raw, decoded };
}
