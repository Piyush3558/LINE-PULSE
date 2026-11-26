import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const project = fileURLToPath(new URL('../', import.meta.url));
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, project, 'LINE_PULSE_');
  return {
    plugins: [react()],
    envDir: project,
    server: {
      host: '127.0.0.1',
      port: Number(env.LINE_PULSE_FRONTEND_PORT ?? 5173),
      strictPort: true,
      proxy: { '/api': { target: `http://127.0.0.1:${env.LINE_PULSE_PORT ?? 8765}` } },
    },
  };
});
