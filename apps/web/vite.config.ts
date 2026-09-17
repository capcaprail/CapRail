import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// `.env` lives at the monorepo root next to the api's and worker's variables;
// only `VITE_*` names cross into the bundle.
export default defineConfig({
  plugins: [react()],
  // GitHub Pages serves a project site under `/<repo>/`; the Pages workflow sets
  // BASE_PATH, a local build and a custom domain keep `/`.
  base: process.env.BASE_PATH ?? '/',
  envDir: fileURLToPath(new URL('../../', import.meta.url)),
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5173 },
})
