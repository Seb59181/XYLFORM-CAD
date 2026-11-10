import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

// version affichée par l'écran de démarrage (%VITE_APP_VERSION% dans index.html)
process.env.VITE_APP_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // fichier WebAssembly de LibreDWG (lecture DWG), non exposé par le paquet
      { find: /^libredwg-wasm/, replacement: fileURLToPath(new URL('./node_modules/@mlightcad/libredwg-web/wasm/libredwg-web.wasm', import.meta.url)) },
    ],
  },
  // modules Emscripten chargés tels quels (leur .wasm est localisé explicitement)
  optimizeDeps: { exclude: ['opencascade.js', '@mlightcad/libredwg-web'] },
  worker: { format: 'es' },
  server: { port: 5173, open: !process.env.CI && !process.env.NO_OPEN },
  preview: { port: 4173 },
  build: { target: 'es2022', chunkSizeWarningLimit: 6000, assetsInlineLimit: 0 },
});
