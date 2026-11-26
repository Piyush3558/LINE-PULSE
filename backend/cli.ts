import { parseArgs } from 'node:util';
import { constants } from 'node:fs';
import { writeFile, mkdir, access, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { bootstrapAdmin, legacySignals, readLegacyConfig, seedPilot } from './pilot.js';
import { preview, validAddress } from './config.js';
import { localCollectorLock } from './collector.js';
import { readSnapshot } from './plc.js';
import { runDiagnostics } from './diagnostics.js';
import { runReports } from './reports.js';
import { importArchive } from './archive.js';
import { dataPath, frontendDist } from './paths.js';
import { assignThisCollector, checkDatabase, makeWindowsProfile } from './shared-db.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: 'string' }, module: { type: 'string' }, database: { type: 'string' },
    output: { type: 'string' }, username: { type: 'string' }, date: { type: 'string' }, machine: { type: 'string' },
    minutes: { type: 'string' }, interval: { type: 'string' }, timeout: { type: 'string' },
    'confirm-read-only': { type: 'boolean' }, json: { type: 'boolean' },
    'hmi-before-ok': { type: 'string' }, 'hmi-after-ok': { type: 'string' },
    'hmi-before-ng': { type: 'string' }, 'hmi-after-ng': { type: 'string' },
    'prompt-hmi': { type: 'boolean' },
  },
});
const [command, ...args] = positionals;
const callerPath = (file: string) => resolve(process.env.INIT_CWD ?? process.cwd(), file);
for (const option of ['config', 'database', 'output'] as const) {
  if (values[option]) values[option] = callerPath(values[option]);
}

try {
  if (command === 'db-check' || command === 'shared-setup') {
    await checkDatabase();
    if (command === 'shared-setup' && process.env.LINE_PULSE_SETUP_MACHINE_CODE) {
      await assignThisCollector(process.env.LINE_PULSE_SETUP_MACHINE_CODE);
    }
  } else if (command === 'use-local-collector') {
    if (!values.machine) throw new Error('Specify the machine code using --machine');
    await assignThisCollector(values.machine);
  } else if (command === 'make-windows-profile') {
    if (!args[0] || !values.machine) throw new Error('Use make-windows-profile HOST --machine MACHINE_CODE');
    console.log('Copy the two files in this private folder to the Windows project root:', await makeWindowsProfile(args[0],values.machine));
  } else if (command === 'bootstrap-admin') {
    const target = values.output ?? dataPath('initial-admin.txt');
    await mkdir(dirname(target), { recursive: true });
    await bootstrapAdmin(values.username ?? 'admin', target);
    console.log('Initial admin credentials saved in', target);
  } else if (command === 'import-archive') {
    if (!values.database || !values.machine || !args[0]) throw new Error('import-archive SOURCE_NAME --database FILE --machine MACHINE_CODE');
    console.log(await importArchive(values.database, values.machine, args[0]));
  } else if (command === 'seed-pilot') {
    console.log(await seedPilot(values.config) ? 'Pilot machine and drafts created' : 'Pilot machine already exists');
  } else if (['validate-config', 'preflight', 'explain-requests', 'once'].includes(command)) {
    const config = await readLegacyConfig(values.config);
    if (!Number.isInteger(config.poll_interval_seconds) || config.poll_interval_seconds < 2 || config.poll_interval_seconds > 3600) throw new Error('Invalid poll interval');
    const modules = config.modules.filter(module => module.enabled && (!values.module || module.name === values.module.toUpperCase()));
    if (!modules.length) throw new Error('No matching enabled modules');
    const plan = modules.map(module => {
      if (!Number.isInteger(module.port) || module.port < 1 || module.port > 65535 || !Number.isInteger(module.unit_id) || module.unit_id < 0 || module.unit_id > 255) {
        throw new Error(`Invalid endpoint for ${module.name}`);
      }
      return { name: module.name, ip_address: validAddress(module.ip), port: module.port, unit_id: module.unit_id, signals: legacySignals(config, module) };
    });
    if (command === 'preflight') {
      await access(join(frontendDist, 'index.html'), constants.R_OK);
      await mkdir(dataPath(), { recursive: true });
      const sandbox = await mkdtemp(dataPath('preflight-'));
      try { await writeFile(join(sandbox, 'check'), 'ok'); } finally { await rm(sandbox, { recursive: true, force: true }); }
      console.log(`Node ${process.version}. Build, configuration, and local storage checks passed. No PLC contacted.`);
    } else if (command === 'validate-config') console.log(`Validated ${plan.length} modules offline`);
    else if (command === 'explain-requests') console.log(JSON.stringify(plan.map(item => ({ ...item, reads: preview(item.signals, item.unit_id) })), null, 2));
    else {
      if (!values['confirm-read-only']) throw new Error('Use --confirm-read-only after reviewing the request plan');
      const lock = await localCollectorLock();
      try {
        for (const item of plan) console.log(JSON.stringify({ module: item.name, ...await readSnapshot(item, item.signals) }));
      } finally { lock.close(); }
    }
  } else if (['discovery', 'op50-probe', 'compare-captures'].includes(command)) {
    const paths = command === 'compare-captures' ? args.map(callerPath)
      : args[0] === 'analyze' && args[1] ? [args[0], callerPath(args[1])] : args;
    await runDiagnostics(command, paths, values);
  } else if (['report', 'audit'].includes(command)) {
    await runReports(command, values);
  } else {
    console.log('Line Pulse commands: preflight, db-check, shared-setup, use-local-collector, make-windows-profile, seed-pilot, bootstrap-admin, import-archive, validate-config, explain-requests, once, discovery, op50-probe, compare-captures, report, audit');
    if (command) process.exitCode = 1;
  }
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
}
