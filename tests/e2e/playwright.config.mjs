// Configuracion Playwright para QA de la camara (tests/e2e).
// Los servidores (backend en 8080, frontend estatico en 3000) se levantan fuera de este archivo.
import { defineConfig } from '@playwright/test';
import os from 'node:os';
import path from 'node:path';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  outputDir: process.env.QA_OUT_DIR || path.join(os.tmpdir(), 'qa-camera-e2e'),
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3000',
    headless: true,
    viewport: { width: 1280, height: 800 },
    screenshot: 'off',
    trace: 'off',
    video: 'off',
  },
});
