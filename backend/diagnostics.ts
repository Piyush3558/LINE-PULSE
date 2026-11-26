import { mkdir, readFile, writeFile, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';
import { parse } from 'csv-parse/sync';
import { type Endpoint, readBlocks, type Read } from './plc.js';
import { csv } from './history.js';
import { localCollectorLock } from './collector.js';
import { readLegacyConfig } from './pilot.js';
import { dataPath } from './paths.js';

type Options = Record<string, string | boolean | undefined>;
type Range = [kind: 'M' | 'D', start: number, quantity: number];
const ranges: Record<string, Range[]> = {
  OP10: [['M',120,151],['D',0,32],['D',390,21]],
  OP20: [['M',200,71],['D',0,32],['D',390,21]],
  OP30: [['M',200,91],['D',0,32],['D',390,21]],
  OP40: [['M',200,61],['D',0,32],['D',390,21]],
  OP50: [['M',70,16],['M',200,51],['D',0,32],['D',390,21]],
};
const captureFields = ['observed_at_utc','observed_at_local','sample_number','module_name','module_ip','device','value'];

export function localIso(date: Date) {
  const offset = -date.getTimezoneOffset();
  const pad = (n: number) => String(n).padStart(2, '0');
  const local = new Date(date.valueOf() + offset * 60000).toISOString().slice(0, -1);
  return `${local}${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

function numberOption(options: Options, name: string, fallback: number, low: number, high: number) {
  const value = Number(options[name] ?? fallback);
  if (!Number.isFinite(value) || value < low || value > high) throw new Error(`--${name} must be between ${low} and ${high}`);
  return value;
}
function asRead([kind, start, quantity]: Range): Read {
  return { function_code: kind === 'M' ? 1 : 3, address: kind === 'M' ? 0x2000 + start : start, quantity };
}
async function captureData(module: string, endpoint: Endpoint, plans: Range[][], options: Options, probe: boolean) {
  if (!options['confirm-read-only']) throw new Error('Use --confirm-read-only after stopping the collector process and reviewing the plan');
  const interval = probe ? 10 : numberOption(options, 'interval', 10, 10, 60);
  const seconds = probe ? 120 : numberOption(options, 'minutes', 10, 1, 30) * 60;
  const timeout = probe ? 2000 : numberOption(options, 'timeout', 2, .5, 3) * 1000;
  const output = String(options.output ?? dataPath('discovery', `${probe ? 'op50_d64_d383' : module.toLowerCase()}_${new Date().toISOString().replaceAll(':','-')}.csv`));
  const lock = await localCollectorLock();
  let stopped = false;
  const stop = () => { stopped = true; };
  process.once('SIGINT', stop);
  try {
    await mkdir(dirname(output), { recursive: true });
    const file = await open(output, 'wx');
    try {
      await file.write(captureFields.join(',') + '\r\n');
      let errors = 0;
      const deadline = performance.now() + seconds * 1000;
      for (let sample = 1; !stopped && performance.now() < deadline && (!probe || sample <= plans.length); sample++) {
        const start = performance.now();
        const plan = plans[probe ? sample - 1 : 0];
        try {
          const result = await readBlocks(endpoint, plan.map(asRead), timeout);
          const at = new Date();
          const rows = plan.flatMap(([kind, address], index) => result.values[index].map((value, offset) => ({
            observed_at_utc: at.toISOString(), observed_at_local: localIso(at), sample_number: sample,
            module_name: module, module_ip: endpoint.ip_address, device: kind + (address + offset), value: Number(value),
          })));
          await file.write(csv(rows, captureFields).split('\r\n').slice(1).join('\r\n'));
          errors = 0;
          console.log(`Sample ${sample} saved (${rows.length} values)`);
        } catch (error) {
          console.error(`Sample ${sample}: ${(error as Error).message}`);
          if (++errors >= 3 || probe) throw new Error('Capture stopped after failed reads');
        }
        if (!stopped && (!probe || sample < plans.length)) {
          await delay(Math.max(0, Math.min(deadline - performance.now(), interval * 1000 - (performance.now() - start))));
        }
      }
    } finally { await file.close(); }
  } finally {
    process.removeListener('SIGINT', stop);
    lock.close();
  }
  console.log('Saved', output);
}

async function loadCapture(path: string) {
  const records = parse(await readFile(path), { columns: true, bom: true, skip_empty_lines: true }) as Array<Record<string,string>>;
  const identity = records[0] && [records[0].module_name, records[0].module_ip].join('/');
  if (!identity) throw new Error(`${path} has no samples`);
  const histories = new Map<string, Array<{ at: string; value: number }>>();
  for (const row of records) {
    if (!captureFields.filter(field => field !== 'observed_at_utc').every(field => Object.hasOwn(row, field))
        || [row.module_name,row.module_ip].join('/') !== identity || !/^\d+$/.test(row.sample_number)
        || !/^-?\d+$/.test(row.value) || !/^[MD]\d+$/.test(row.device)) throw new Error(`Invalid or mixed capture: ${path}`);
    const history = histories.get(row.device) ?? [];
    history.push({ at: row.observed_at_local, value: Number(row.value) });
    histories.set(row.device, history);
  }
  return { identity, histories };
}

const changes = (rows: Array<{ value: number }>) => rows.reduce((count, item, i) => count + Number(i > 0 && item.value !== rows[i - 1].value), 0);

export async function runDiagnostics(command: string, args: string[], options: Options) {
  if (command === 'compare-captures') {
    if (args.length !== 2 || typeof options.output !== 'string') throw new Error('compare-captures BASELINE RUNNING --output FILE');
    const [base, running] = await Promise.all(args.map(loadCapture));
    if (base.identity !== running.identity || base.histories.size !== running.histories.size || [...base.histories.keys()].some(key => !running.histories.has(key))) throw new Error('Captures must have the same module, endpoint, and device set');
    const hmi: Record<string, number> = {};
    const names = ['hmi-before-ok','hmi-after-ok','hmi-before-ng','hmi-after-ng'];
    if (options['prompt-hmi']) {
      if (names.some(key => options[key] !== undefined)) throw new Error('Use either --prompt-hmi or explicit totals');
      const dialog = createInterface({ input: process.stdin, output: process.stdout });
      try { for (const key of names) options[key] = await dialog.question(`${key} `); } finally { dialog.close(); }
    }
    for (const key of names) if (options[key] !== undefined) {
      if (!/^\d+$/.test(String(options[key]))) throw new Error(`Invalid --${key} total`);
      hmi[key] = Number(options[key]);
    }
    for (const outcome of ['ok','ng']) if ((hmi[`hmi-before-${outcome}`] === undefined) !== (hmi[`hmi-after-${outcome}`] === undefined)) throw new Error('Supply both before and after totals for each outcome');
    const rows = [...base.histories.keys()].sort((a,b) => a[0].localeCompare(b[0]) || Number(a.slice(1)) - Number(b.slice(1))).map(device => {
      const before = base.histories.get(device)!;
      const after = running.histories.get(device)!;
      const delta = after.at(-1)!.value - before.at(-1)!.value;
      const baselineChanges = changes(before);
      const candidates = [];
      for (const outcome of ['ok','ng']) {
        const final = hmi[`hmi-after-${outcome}`];
        if (device[0] === 'D' && delta > 0 && baselineChanges === 0 && delta === final - hmi[`hmi-before-${outcome}`]) {
          candidates.push(`${outcome.toUpperCase()} ${after.at(-1)!.value === final ? 'total+delta match' : 'delta match only'}`);
        }
      }
      return { device, baseline_first: before[0].value, baseline_last: before.at(-1)!.value, running_first: after[0].value,
        running_last: after.at(-1)!.value, delta, baseline_changes: baselineChanges, running_changes: changes(after),
        candidate: candidates.join('; '), baseline_last_at: before.at(-1)!.at, running_last_at: after.at(-1)!.at };
    });
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, csv(rows.filter(row => row.delta || row.running_changes), Object.keys(rows[0])), { flag: 'wx' });
    console.log('Saved', options.output);
    return;
  }

  const action = args[0];
  if (command === 'discovery' && action === 'analyze') {
    if (!args[1]) throw new Error('discovery analyze FILE');
    const data = await loadCapture(args[1]);
    console.log(JSON.stringify({ identity: data.identity, devices: [...data.histories].map(([device, rows]) =>
      ({ device, first: rows[0].value, last: rows.at(-1)!.value, changes: changes(rows) })) }, null, 2));
    return;
  }
  if (command === 'discovery' && !['explain','capture'].includes(action)) throw new Error('discovery explain|capture --module OP10; discovery analyze FILE');
  const probe = command === 'op50-probe';
  const module = probe ? 'OP50' : String(options.module ?? '').toUpperCase();
  if (!Object.hasOwn(ranges, module)) throw new Error('Select OP10, OP20, OP30, OP40, or OP50');
  const config = await readLegacyConfig(typeof options.config === 'string' ? options.config : undefined);
  const node = config.modules.find(item => item.name === (module === 'OP50' ? 'OP50A' : module));
  if (!node) throw new Error('PLC endpoint is missing from the supplied configuration');
  const endpoint = { ip_address: node.ip, port: node.port, unit_id: node.unit_id };
  const plans: Range[][] = probe ? Array.from({ length: 10 }, (_, i) => [['D', 64 + 32 * i, 32]]) : [ranges[module]];
  console.log(JSON.stringify({ module, endpoint, requests: plans.flat().map(asRead) }, null, 2));
  if (probe || action === 'capture') await captureData(module, endpoint, plans, options, probe);
}
