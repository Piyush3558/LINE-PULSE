import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { assignThisCollector, checkDatabase } from '../backend/shared-db.ts';
import { dataPath, projectPath } from '../backend/paths.ts';

async function checkPort(port) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(error.code === 'EADDRINUSE'
      ? new Error(`Port ${port} is already in use. Close the other Line Pulse terminal or stop its services, then retry.`)
      : error));
    server.listen(port, '127.0.0.1', () => server.close(error => error ? reject(error) : resolve()));
  });
}

const frontend = Number(process.env.LINE_PULSE_FRONTEND_PORT ?? 5173);
try {
  if (!process.env.LINE_PULSE_API_DSN || !process.env.LINE_PULSE_WORKER_DSN) {
    throw new Error('Set up the database or place the shared database profile in the project folder first.');
  }
  for (const port of [frontend, Number(process.env.LINE_PULSE_PORT ?? 8765), Number(process.env.LINE_PULSE_COLLECTOR_LOCK_PORT ?? 8766)]) {
    await checkPort(port);
  }
  if (process.env.LINE_PULSE_DB_CA_FILE) {
    await checkDatabase();
    const machine = process.env.LINE_PULSE_SETUP_MACHINE_CODE;
    const collector = process.env.LINE_PULSE_COLLECTOR_KEY;
    const marker = dataPath('shared-collector-assignment');
    if (machine && collector) {
      const expected = `${machine}/${collector}\n`;
      const previous = await readFile(marker, 'utf8').catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return '';
      });
      if (previous !== expected) {
        await assignThisCollector(machine);
        await mkdir(dataPath(), { recursive: true });
        await writeFile(marker, expected, { mode: 0o600 });
      }
    }
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const children = [
  spawn(process.execPath, [projectPath('backend', 'start.ts'), '--watch'], {
    cwd: projectPath('backend'), stdio: 'inherit',
  }),
  spawn(process.execPath, [fileURLToPath(new URL('vite.mjs', import.meta.url))], {
    cwd: projectPath('frontend'), stdio: 'inherit',
  }),
];

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    } else child.kill('SIGTERM');
  }
}
for (const child of children) {
  child.once('error', error => { console.error(error.message); stop(1); });
  child.once('exit', code => stop(code ?? 1));
}
process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
