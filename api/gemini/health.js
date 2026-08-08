/**
 * health.js — AI Health Check Serverless Endpoint
 *
 * GET /api/gemini/health
 * Returns { status, model, configured, timestamp }
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env.local in local dev. Vercel injects env vars natively.
if (process.env.NODE_ENV !== 'production') {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname  = dirname(__filename);
        dotenv.config({ path: join(__dirname, '../../.env.local'), override: true });
    } catch (_) {}
}

export default function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'GET') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    const key = process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY || '';
    const configured = key.startsWith('sk-');

    return res.status(200).json({
        status:     'ok',
        model:      'gpt-4o-mini',
        configured,
        timestamp:  new Date().toISOString(),
        serverless: true,
    });
}
