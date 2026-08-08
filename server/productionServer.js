/**
 * productionServer.js — Unified Production Server for MEDROUTER
 *
 * Serves the Vite production build (static files) via Express.
 * Provides SPA fallback routing so client-side routes work.
 *
 * Usage (inside Docker):
 *   node server/productionServer.js
 */

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

const app = express();
const PORT = process.env.PORT || 5173;

// ─── Health check ───────────────────────────────────────────
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Serve static Vite build ────────────────────────────────
const distPath = join(PROJECT_ROOT, 'dist');
app.use(express.static(distPath, {
  maxAge: '1d',
  etag: true,
}));

// ─── SPA fallback — serve index.html for all unmatched routes
// Express v5 requires named wildcard params instead of bare '*'
app.get('{*path}', (_req, res) => {
  res.sendFile(join(distPath, 'index.html'));
});

// ─── Error handler ──────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ──────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 MEDROUTER Production Server`);
  console.log(`   Serving static build from: ${distPath}`);
  console.log(`   Listening on: http://0.0.0.0:${PORT}`);
  console.log(`   Health check: http://0.0.0.0:${PORT}/healthz\n`);
});
