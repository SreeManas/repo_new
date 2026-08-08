/**
 * chat.js — GPT-5 mini AI Copilot Serverless Endpoint
 * 
 * Vercel serveless function that handles chat requests to OpenAI API.
 * Replaces Express server at server/geminiChat.js
 * 
 * POST /api/gemini/chat
 */

import { SYSTEM_PROMPTS, getExplainabilityInstruction } from '../utils/prompts.js';
import { getSuggestedPrompts } from '../utils/suggestedPrompts.js';
import { generateContent } from '../utils/llmClient.js';

// Constants
const VALID_ROLES = ['paramedic', 'hospital_admin', 'command_center', 'dispatcher', 'admin'];

// In-memory conversation history (serverless — will reset per cold start)
// For production, consider Vercel KV or Firestore
const conversationHistory = new Map();
const MAX_HISTORY = 20;
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

function getSessionHistory(sessionId) {
    const entry = conversationHistory.get(sessionId);
    if (!entry || Date.now() > entry.expiresAt) return [];
    return entry.messages;
}

function addToHistory(sessionId, role, text) {
    let entry = conversationHistory.get(sessionId);
    if (!entry || Date.now() > entry.expiresAt) {
        entry = { messages: [], expiresAt: Date.now() + SESSION_TTL };
    }
    entry.messages.push({ role, parts: [{ text }] });
    if (entry.messages.length > MAX_HISTORY) {
        entry.messages = entry.messages.slice(-MAX_HISTORY);
    }
    entry.expiresAt = Date.now() + SESSION_TTL;
    conversationHistory.set(sessionId, entry);
}

/**
 * Build minimal context (stateless for MVP — no Firestore)
 * For full context, integrate Firebase Admin here
 */
function buildSimpleContext(role, contextIds = {}) {
    return {
        role,
        data: {
            caseId: contextIds.caseId || null,
            hospitalId: contextIds.hospitalId || null,
            // Add more context from Firestore in future
        }
    };
}

export default async function handler(req, res) {
    // CORS headers for Vercel
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({
            success: false,
            error: 'Method not allowed'
        });
    }

    try {
        // ═══════════════════════════════════════════════════════
        // STEP 1: Parse and validate request body
        // ═══════════════════════════════════════════════════════
        let body;

        // Handle different body types (Buffer, string, object)
        if (Buffer.isBuffer(req.body)) {
            body = JSON.parse(req.body.toString('utf-8'));
        } else if (typeof req.body === 'string') {
            body = JSON.parse(req.body);
        } else if (typeof req.body === 'object') {
            body = req.body;
        } else {
            console.error('Invalid body type:', typeof req.body);
            return res.status(400).json({
                success: false,
                error: 'Invalid request body format'
            });
        }

        console.log('Parsed body:', JSON.stringify(body, null, 2));

        const { message, role, contextIds, sessionId } = body;

        // Validate message
        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            console.error('Validation failed: Invalid message', { message });
            return res.status(400).json({
                success: false,
                error: 'Message is required and must be a non-empty string',
                received: { message, type: typeof message }
            });
        }


        // ═══════════════════════════════════════════════════════
        // STEP 3: Validate role
        // ═══════════════════════════════════════════════════════
        const userRole = VALID_ROLES.includes(role) ? role : 'paramedic';
        console.log('User role:', userRole);

        // Build context
        const roleContext = buildSimpleContext(userRole, contextIds || {});

        // ═══════════════════════════════════════════════════════
        // STEP 4: Build Gemini request
        // ═══════════════════════════════════════════════════════
        const systemPrompt = SYSTEM_PROMPTS[userRole] || SYSTEM_PROMPTS.paramedic;
        const explainability = getExplainabilityInstruction();
        const contextJson = JSON.stringify(roleContext.data, null, 2);

        const fullSystemPrompt = `${systemPrompt}${explainability}

CURRENT CONTEXT DATA:
\`\`\`json
${contextJson}
\`\`\`

Use the above context data to provide accurate, data-driven responses. If the context is empty or incomplete, acknowledge it and provide general EMS guidance.`;

        // Build conversation
        const sid = sessionId || `vercel-${userRole}-${Date.now()}`;
        const history = getSessionHistory(sid);

        const contents = [
            { role: 'model', parts: [{ text: 'Understood. I am ready to assist as your EMS AI Copilot. How can I help?' }] },
            ...history,
            { role: 'user', parts: [{ text: message.trim() }] }
        ];

        // ═══════════════════════════════════════════════════════
        // STEP 5: Call API
        // ═══════════════════════════════════════════════════════
        let llmResponse;
        try {
            llmResponse = await generateContent({
                systemPrompt: fullSystemPrompt,
                messages: contents,
                temperature: 0.7,
                maxTokens: 1024,
                responseFormat: 'text',
                model: 'gpt-4o-mini'
            });
        } catch (apiErr) {
            console.error('LLM API Error:', apiErr);
            return res.status(502).json({
                success: false,
                error: `AI API returned an error`,
                details: apiErr.message,
                fallback: '⚠️ AI Copilot temporarily unavailable. Please try again or consult standard EMS protocols.'
            });
        }

        // ═══════════════════════════════════════════════════════
        // STEP 6: Extract and return response
        // ═══════════════════════════════════════════════════════
        const replyText = llmResponse.text || 'I apologize, but I was unable to generate a response. Please try again.';

        // Store in history
        addToHistory(sid, 'user', message.trim());
        addToHistory(sid, 'model', replyText);

        // Get suggested follow-ups
        const suggestedPrompts = getSuggestedPrompts(userRole, contextIds || {});

        return res.status(200).json({
            success: true,
            reply: replyText,
            suggestedFollowups: suggestedPrompts.slice(0, 4),
            contextUsed: {
                role: userRole,
                hasCase: Boolean(roleContext.data.caseId),
                hasHospital: Boolean(roleContext.data.hospitalId),
                dataAvailable: Object.keys(roleContext.data).filter(k => roleContext.data[k]).length > 0
            }
        });

    } catch (err) {
        console.error('Chat endpoint error:', err);
        console.error('Error stack:', err.stack);

        return res.status(500).json({
            success: false,
            error: 'Internal server error',
            details: err.message,
            fallback: '⚠️ Unable to reach AI Copilot. Showing general EMS guidance: Follow standard protocols and contact medical control if needed.'
        });
    }
}
