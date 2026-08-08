/**
 * /api/voice-intake/index.js — Voice-to-Intake AI Structured Extraction
 *
 * POST /api/voice-intake
 * Receives paramedic speech transcript, returns structured clinical fields.
 * Uses GPT-5 mini with temperature 0.1 for deterministic extraction.
 * Returns JSON-only — rejects free text and malformed output.
 */

import { generateContent } from '../utils/llmClient.js';

const MAX_TRANSCRIPT_LENGTH = 2000;
const REQUEST_TIMEOUT_MS = 10_000;

// ─── In-memory rate limit ──────────────────────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 20;
const RATE_LIMIT_WINDOW_MS = 60_000;

function isRateLimited(ip) {
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (!entry || now > entry.resetAt) {
        rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return false;
    }
    entry.count++;
    if (entry.count > RATE_LIMIT_MAX) return true;
    rateLimitMap.set(ip, entry);
    return false;
}

// ─── Sanitize transcript ───────────────────────────────────────────────────
function sanitizeTranscript(raw) {
    if (typeof raw !== 'string') return '';
    return raw
        .replace(/[`\\]/g, '')          // strip backticks and backslashes
        .replace(/\s+/g, ' ')           // collapse whitespace
        .trim()
        .slice(0, MAX_TRANSCRIPT_LENGTH);
}

// ─── Validate extracted response schema ───────────────────────────────────
function validateExtracted(obj) {
    if (typeof obj !== 'object' || obj === null) return false;
    if (!('extractedData' in obj)) return false;
    if (typeof obj.confidenceScore !== 'number') return false;
    if (!Array.isArray(obj.missingCriticalFields)) return false;
    return true;
}

// ─── System prompt ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are a clinical AI extraction engine for an emergency medical services platform.
Your sole function is to parse paramedic speech transcripts and extract structured patient data.

RULES:
1. Output ONLY valid JSON. No prose, no markdown, no code fences.
2. If a field is not mentioned, use null.
3. Do not infer values not explicitly mentioned.
4. confidenceScore is your 0–1 confidence in the overall extraction quality.
5. missingCriticalFields lists field keys from extractedData that are null but critical for triage.

  OUTPUT SCHEMA (exactly this structure, no extra keys):
{
  "extractedData": {
    "patientName": string | null,
    "age": number | null,
    "gender": "male" | "female" | "other" | null,
    "pregnancyStatus": "pregnant" | "not_pregnant" | "unknown" | null,

    "heartRate": number | null,
    "systolicBP": number | null,
    "diastolicBP": number | null,
    "spo2": number | null,
    "respiratoryRate": number | null,
    "temperature": number | null,

    "consciousnessLevel": "alert" | "voice" | "pain" | "unresponsive" | null,
    "headInjurySuspected": boolean | null,
    "seizureActivity": boolean | null,

    "breathingStatus": "normal" | "labored" | "assisted" | "not_breathing" | null,
    "chestPainPresent": boolean | null,
    "cardiacHistoryKnown": boolean | null,

    "injuryType": "none" | "fracture" | "polytrauma" | "burns" | "laceration" | "internal" | null,
    "bleedingSeverity": "none" | "mild" | "severe" | null,
    "burnsPercentage": number (0-100, body surface area) | null,

    "emergencyType": "cardiac" | "accident" | "medical" | "fire" | "industrial" | "other" | null,

    "oxygenAdministered": boolean | null,
    "cprPerformed": boolean | null,
    "ivFluidsStarted": boolean | null,

    "transportPriority": "immediate" | "urgent" | "delayed" | "minor" | null,
    "ventilatorRequired": boolean | null,
    "oxygenRequired": boolean | null,
    "defibrillatorRequired": boolean | null,
    "spinalImmobilization": boolean | null,

    "suspectedInfectious": boolean | null,
    "isolationRequired": boolean | null,

    "paramedicNotes": string | null,
    "locationDescription": string | null
  },
  "confidenceScore": number,
  "missingCriticalFields": string[]
}

Extraction hints:
- pregnancyStatus: 'pregnant/expecting/gravid'→pregnant, 'not pregnant'→not_pregnant
- consciousnessLevel: 'awake/alert'→alert, 'responds to voice'→voice, 'responds to pain'→pain, 'unconscious/unresponsive/coma'→unresponsive
- breathingStatus: 'SOB/wheezing/labored/difficulty breathing'→labored, 'BVM/intubated/ventilator'→assisted, 'apnea/not breathing'→not_breathing
- injuryType: 'broken bone'→fracture, 'multiple injuries'→polytrauma, 'cut/stab/wound'→laceration, 'internal bleeding/blunt trauma'→internal
- bleedingSeverity: 'heavy/uncontrolled/massive/hemorrhage'→severe, 'minor/slight/controlled'→mild
- burnsPercentage: extract number from '25% burns', 'burns covering 30 percent', 'thirty percent BSA'
- emergencyType: 'RTA/crash/collision'→accident, 'heart attack/MI'→cardiac, 'factory/chemical'→industrial
- transportPriority: 'priority 1/red/stat/critical'→immediate, 'priority 2/yellow'→urgent, 'priority 3/green/stable'→delayed, 'priority 4/white/minor'→minor
- booleans: 'oxygen given/O2 applied/nasal cannula'→oxygenAdministered=true, 'CPR/chest compressions'→cprPerformed=true, 'IV started/normal saline'→ivFluidsStarted=true, 'c-collar/backboard/spinal precautions'→spinalImmobilization=true
Critical fields for triage: ["age", "heartRate", "spo2", "consciousnessLevel", "emergencyType"]`;


export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    if (isRateLimited(ip)) {
        return res.status(429).json({ success: false, error: 'Rate limit exceeded' });
    }

    const { transcript } = req.body || {};
    if (!transcript || typeof transcript !== 'string') {
        return res.status(400).json({ success: false, error: 'transcript is required' });
    }

    const clean = sanitizeTranscript(transcript);
    if (clean.length < 5) {
        return res.status(400).json({ success: false, error: 'Transcript too short' });
    }

    let result;
    try {
        const llmResponse = await generateContent({
            systemPrompt: SYSTEM_PROMPT,
            messages: [{ role: 'user', parts: [{ text: `Extract clinical data from this paramedic transcript:\n\n"${clean}"` }] }],
            temperature: 0.1,
            maxTokens: 2048,
            responseFormat: 'json'
        });

        const rawText = llmResponse.text;
        if (!rawText) {
            return res.status(502).json({ success: false, error: 'Empty AI response' });
        }

        try {
            result = JSON.parse(rawText);
        } catch {
            // Strip any accidental markdown fences
            const stripped = rawText.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
            try {
                result = JSON.parse(stripped);
            } catch {
                return res.status(502).json({ success: false, error: 'AI returned malformed JSON', raw: rawText.slice(0, 200) });
            }
        }

        if (!validateExtracted(result)) {
            return res.status(502).json({ success: false, error: 'AI response failed schema validation', raw: rawText.slice(0, 200) });
        }

    } catch (err) {
        if (err.name === 'AbortError') {
            return res.status(504).json({ success: false, error: 'Request timed out after 10 seconds' });
        }
        console.error('Voice intake request error:', err);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }

    return res.status(200).json({ success: true, ...result });
}
