import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const mafiaPreview = process.env.MAFIA_PREVIEW_URL;
if (mafiaPreview && !/^http:\/\/127\.0\.0\.1:\d{4,5}$/.test(mafiaPreview)) throw new Error('The Mafia preview API must be a loopback origin.');
export default defineConfig({ plugins: [react()], server: { host: '127.0.0.1', port: 5180, strictPort: true,
  ...(mafiaPreview ? { proxy: { '/mafia-api': { target: mafiaPreview, rewrite: (path: string) => path.replace(/^\/mafia-api/, '') } } } : {}) } });
