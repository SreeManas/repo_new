/**
 * geminiChat.js — Gemini 2.5 Flash AI Copilot Backend Proxy
 * 
 * Express server that proxies chat messages to Gemini API.
 * Injects role-specific context from Firestore.
 * API key never exposed to frontend.
 * 
 * Endpoint:
 *   POST /api/gemini/chat
 * 
 * Usage:
 *   node server/geminiChat.js
 *   # or: npm run gemini-server
 */

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { buildRoleContext } from './roleContextBuilder.js';
import { SYSTEM_PROMPTS, getExplainabilityInstruction } from './systemPrompts.js';
import { getSuggestedPrompts } from './suggestedPrompts.js';
import { generateContent } from '../api/utils/llmClient.js';

// Load env from server/.env
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '.env') });

const app = express();
const PORT = process.env.GEMINI_PORT || 5002;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Valid EMS roles
const VALID_ROLES = ['paramedic', 'hospital_admin', 'command_center', 'dispatcher', 'admin'];

// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

app.use(express.json());
app.use(cors({
    origin: ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'],
    methods: ['POST', 'GET'],
    credentials: true
}));

// ─── Simple Rate Limiting ────────────────────────────────────
const rateLimit = {};
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 15;       // 15 requests per minute per IP

function rateLimitMiddleware(req, res, next) {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();

    if (!rateLimit[ip]) {
        rateLimit[ip] = { count: 1, resetAt: now + RATE_LIMIT_WINDOW };
        return next();
    }

    if (now > rateLimit[ip].resetAt) {
        rateLimit[ip] = { count: 1, resetAt: now + RATE_LIMIT_WINDOW };
        return next();
    }

    rateLimit[ip].count++;
    if (rateLimit[ip].count > RATE_LIMIT_MAX) {
        return res.status(429).json({
            success: false,
            error: 'Rate limit exceeded. Please wait before sending more messages.'
        });
    }

    next();
}

// ═══════════════════════════════════════════════════════════════
// CONVERSATION HISTORY (in-memory, keyed by session)
// ═══════════════════════════════════════════════════════════════

const conversationHistory = new Map();
const MAX_HISTORY = 20; // Keep last 20 messages per session
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

function getSessionHistory(sessionId) {
    const entry = conversationHistory.get(sessionId);
    if (!entry) return [];
    if (Date.now() > entry.expiresAt) {
        conversationHistory.delete(sessionId);
        return [];
    }
    return entry.messages;
}

function addToHistory(sessionId, role, text) {
    let entry = conversationHistory.get(sessionId);
    if (!entry || Date.now() > entry.expiresAt) {
        entry = { messages: [], expiresAt: Date.now() + SESSION_TTL };
    }
    entry.messages.push({ role, parts: [{ text }] });
    // Trim to max
    if (entry.messages.length > MAX_HISTORY) {
        entry.messages = entry.messages.slice(-MAX_HISTORY);
    }
    entry.expiresAt = Date.now() + SESSION_TTL;
    conversationHistory.set(sessionId, entry);
}

// Cleanup expired sessions periodically
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of conversationHistory) {
        if (now > val.expiresAt) conversationHistory.delete(key);
    }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════
// MAIN CHAT ENDPOINT
// ═══════════════════════════════════════════════════════════════

app.post('/api/gemini/chat', rateLimitMiddleware, async (req, res) => {
    try {
        const { message, role, contextIds, sessionId } = req.body;

        // Validate inputs
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Message is required'
            });
        }

        if (!GEMINI_API_KEY) {
            return res.status(500).json({
                success: false,
                error: 'Gemini API key not configured on server'
            });
        }

        // Validate and normalize role
        const userRole = VALID_ROLES.includes(role) ? role : 'paramedic';

        // Build role-specific context from Firestore
        let roleContext;
        try {
            roleContext = await buildRoleContext(userRole, contextIds || {});
        } catch (err) {
            console.error('Context building failed:', err.message);
            roleContext = { role: userRole, data: {}, error: 'Context unavailable' };
        }

        // Build system prompt
        const systemPrompt = SYSTEM_PROMPTS[userRole] || SYSTEM_PROMPTS.paramedic;
        const explainability = getExplainabilityInstruction();

        const contextJson = JSON.stringify(roleContext.data, null, 2);
        const fullSystemPrompt = `${systemPrompt}${explainability}

CURRENT CONTEXT DATA:
\`\`\`json
${contextJson}
\`\`\`

Use the above context data to provide accurate, data-driven responses. If the context is empty or incomplete, acknowledge it and provide general EMS guidance.`;

        // Build conversation for Gemini
        const sid = sessionId || `${req.ip}-${userRole}`;
        const history = getSessionHistory(sid);

        const contents = [
            { role: 'model', parts: [{ text: 'Understood. I am ready to assist as your EMS AI Copilot. How can I help?' }] },
            ...history,
            { role: 'user', parts: [{ text: message.trim() }] }
        ];

        let llmResponse;
        try {
            llmResponse = await generateContent({
                systemPrompt: fullSystemPrompt,
                messages: contents,
                temperature: 0.7,
                maxTokens: 1024,
                responseFormat: 'text',
                model: 'gpt-5-mini'
            });
        } catch (apiErr) {
            console.error('LLM API error:', apiErr);
            return res.status(502).json({
                success: false,
                error: `AI API returned an error`,
                details: apiErr.message
            });
        }

        // Extract response text
        const replyText = llmResponse.text || 'I apologize, but I was unable to generate a response. Please try again.';

        // Store in conversation history
        addToHistory(sid, 'user', message.trim());
        addToHistory(sid, 'model', replyText);

        // Get suggested follow-up prompts
        const suggestedPrompts = getSuggestedPrompts(userRole, contextIds || {});

        res.json({
            success: true,
            reply: replyText,
            suggestedFollowups: suggestedPrompts.slice(0, 4),
            contextUsed: {
                role: userRole,
                hasCase: Boolean(roleContext.data.assignedCase),
                hasHospital: Boolean(roleContext.data.hospital),
                dataAvailable: Object.keys(roleContext.data).length > 0
            }
        });

    } catch (err) {
        console.error('Chat endpoint error:', err);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// ─── Suggested Prompts Endpoint ──────────────────────────────
app.get('/api/gemini/suggestions', (req, res) => {
    const role = VALID_ROLES.includes(req.query.role) ? req.query.role : 'paramedic';
    const contextIds = {
        caseId: req.query.caseId || null,
        hospitalId: req.query.hospitalId || null
    };

    res.json({
        success: true,
        prompts: getSuggestedPrompts(role, contextIds)
    });
});

// ─── Health Check ────────────────────────────────────────────
app.get('/api/gemini/health', (req, res) => {
    res.json({
        status: 'ok',
        model: GEMINI_MODEL,
        configured: Boolean(GEMINI_API_KEY),
        timestamp: new Date().toISOString()
    });
});

// ═══════════════════════════════════════════════════════════════
// ERROR HANDLER
// ═══════════════════════════════════════════════════════════════

app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ success: false, error: 'Internal server error' });
});

// ═══════════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
    console.log(`\n🤖 EMS AI Copilot Server running on port ${PORT}`);
    console.log(`   Health: http://localhost:${PORT}/api/gemini/health`);
    console.log(`   Chat:   POST http://localhost:${PORT}/api/gemini/chat`);
    console.log(`   Gemini: ${GEMINI_API_KEY ? '✅ configured' : '❌ NOT configured'}`);
    console.log(`   Model:  gpt-5-mini\n`);
});
