/**
 * llmClient.js — Provider-agnostic OpenAI wrapper
 *
 * Lazy client creation: the OpenAI client is created fresh per call,
 * so the API key is always read from process.env at the time of the
 * actual request. This avoids stale module-cache issues in Vite dev.
 */

import OpenAI from 'openai';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

export const DEFAULT_MODEL = 'gpt-4o-mini';

// ─── Load .env.local in local dev. Vercel injects env vars natively. ──────
if (process.env.NODE_ENV !== 'production') {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname  = dirname(__filename);
        dotenv.config({ path: join(__dirname, '../../.env.local'), override: true });
    } catch (_) {}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function getApiKey() {
    const key = process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY || '';
    if (!key) {
        throw new Error('OPENAI_API_KEY is not set. Add it to .env.local.');
    }
    // Guard: reject any non-OpenAI key (e.g. Google/Firebase AIzaSy... keys)
    if (!key.startsWith('sk-')) {
        throw new Error(
            `Invalid OPENAI_API_KEY — expected key starting with "sk-", got "${key.slice(0, 8)}...". ` +
            'Check your .env.local — a Google/Firebase key may be overriding the OpenAI key.'
        );
    }
    return key;
}

function getClient() {
    return new OpenAI({ apiKey: getApiKey() });
}

// ─── Message normalizer (converts Gemini-style parts[] → OpenAI format) ─────

function normalizeMessages(systemPrompt, messages) {
    const result = [];
    if (systemPrompt) {
        result.push({ role: 'system', content: systemPrompt });
    }
    if (Array.isArray(messages)) {
        for (const msg of messages) {
            const role = msg.role === 'model' ? 'assistant' : (msg.role || 'user');
            let content = '';
            if (Array.isArray(msg.parts)) {
                content = msg.parts.map(p => p.text || '').join('\n');
            } else if (typeof msg.content === 'string') {
                content = msg.content;
            }
            if (content.trim()) {
                result.push({ role, content });
            }
        }
    }
    return result;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Generate a text or JSON completion.
 *
 * @param {object} opts
 * @param {string}  opts.systemPrompt
 * @param {Array}   opts.messages   - [{ role, parts: [{text}] }] or [{ role, content }]
 * @param {number}  [opts.temperature=0.7]
 * @param {number}  [opts.maxTokens=1024]
 * @param {string}  [opts.responseFormat='text']  'text' | 'json'
 * @param {string}  [opts.model]
 * @returns {Promise<{ text: string, raw: object }>}
 */
export async function generateContent({
    systemPrompt,
    messages,
    temperature   = 0.7,
    maxTokens     = 1024,
    responseFormat = 'text',
    model          = DEFAULT_MODEL,
}) {
    const client  = getClient();
    const msgList = normalizeMessages(systemPrompt, messages);

    const options = {
        model,
        messages: msgList,
        max_completion_tokens: maxTokens,
    };

    if (responseFormat === 'json') {
        options.response_format = { type: 'json_object' };
    }

    const completion = await client.chat.completions.create(options);

    return {
        text: completion.choices[0]?.message?.content || '',
        raw:  completion,
    };
}

/**
 * Transcribe audio then extract structured data from the transcript.
 *
 * @param {object} opts
 * @param {string}  opts.systemPrompt
 * @param {string}  opts.audioBase64
 * @param {string}  opts.mimeType
 * @param {number}  [opts.temperature=0.1]
 * @param {number}  [opts.maxTokens=2048]
 * @param {string}  [opts.model]
 * @returns {Promise<{ text: string, transcript: string }>}
 */
export async function generateContentFromAudio({
    systemPrompt,
    audioBase64,
    mimeType,
    temperature = 0.1,
    maxTokens   = 2048,
    model       = DEFAULT_MODEL,
}) {
    const client = getClient();

    // 1. Decode audio
    const audioBuffer = Buffer.from(audioBase64, 'base64');
    let ext = 'webm';
    if (mimeType.includes('ogg')) ext = 'ogg';
    else if (mimeType.includes('mp4')) ext = 'mp4';
    else if (mimeType.includes('wav')) ext = 'wav';

    const file = await OpenAI.toFile(audioBuffer, `audio.${ext}`, { type: mimeType });

    // 2. Transcribe with Whisper
    const transcription = await client.audio.transcriptions.create({
        file,
        model: 'whisper-1',
    });
    const transcript = transcription.text;

    // 3. Extract structured data from transcript
    const textRes = await generateContent({
        systemPrompt,
        messages: [{
            role: 'user',
            parts: [{ text: `Audio transcript:\n"${transcript}"\n\nExtract the requested data.` }],
        }],
        temperature,
        maxTokens,
        responseFormat: 'json',
        model,
    });

    return {
        text:       textRes.text,
        transcript,
    };
}
