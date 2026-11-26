import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../frontend/package.json', import.meta.url));
const vite = join(dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
await import(pathToFileURL(vite).href);
