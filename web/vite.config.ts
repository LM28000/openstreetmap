import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // En développement, l'API est servie par le serveur Rust (dossier server/), sur cette
    // machine par défaut. Pour utiliser un autre serveur : CARTE_API=http://192.168.0.75:8787 pnpm dev
    proxy: { '/api': process.env.CARTE_API ?? 'http://127.0.0.1:8787' },
  },
});
