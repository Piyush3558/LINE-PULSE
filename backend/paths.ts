import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const projectPath = (...path: string[]) => resolve(projectRoot, ...path);
export const defaultConfig = projectPath('backend', 'config', 'modules.json');
export const dataPath = (...path: string[]) => projectPath('data', ...path);
export const frontendDist = projectPath('frontend', 'dist');
