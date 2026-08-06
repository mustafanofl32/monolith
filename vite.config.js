import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the built site works from a GitHub Pages project subpath without knowing
  // the repository name at build time.
  base: './',
  build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
  server: { port: 5173, strictPort: true },
});
