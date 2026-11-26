import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

async function checkPort(port: number, name: string) {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        reject(new Error(`${name} port ${port} is already in use. Stop the running Line Pulse backend and collector before starting another instance.`));
      } else reject(error);
    });
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()));
  });
}

try {
  await checkPort(Number(process.env.LINE_PULSE_PORT ?? 8765), 'API');
  await checkPort(Number(process.env.LINE_PULSE_COLLECTOR_LOCK_PORT ?? 8766), 'Collector');
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const watch = process.argv.includes('--watch');
const children = ['server.ts', 'worker.ts'].map(path => spawn(
  process.execPath, [...(watch ? ['--watch'] : []), '--import', 'tsx', fileURLToPath(new URL(path, import.meta.url))],
  { stdio: 'inherit', env: { ...process.env, ...(watch ? { LINE_PULSE_DEV: '1' } : {}) } },
));
let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
}
for (const child of children) {
  child.on('error', error => { console.error(error.message); stop(1); });
  child.once('exit', code => stop(code ?? 1));
}
process.once('SIGINT', () => stop(0));
process.once('SIGTERM', () => stop(0));
