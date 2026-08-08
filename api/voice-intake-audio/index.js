/**
 * /api/voice-intake-audio/index.js
 *
 * Accepts: { audio: "<base64>", mimeType: "audio/webm" | "audio/ogg" | ... }
 * Uses GPT-5 mini multimodal to:
 *   1. Transcribe the audio
 *   2. Extract structured clinical fields in ONE call
 * Returns: { success, transcript, extractedData, confidenceScore, missingCriticalFields }
 */

import { generateContentFromAudio } from '../utils/llmClient.js';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

const JSON_SCHEMA = `{
  "transcript": "string — verbatim transcription of the audio",

  "patientName": "string or null — patient's name if mentioned",
  "age": "number or null — patient age in years",
  "gender": "male|female|other or null",
  "pregnancyStatus": "pregnant|not_pregnant|unknown or null — extract from 'pregnant', 'not pregnant', 'gravid'",

  "heartRate": "number or null — heart rate in bpm",
  "systolicBP": "number or null — systolic blood pressure",
  "diastolicBP": "number or null — diastolic blood pressure",
  "spo2": "number or null — oxygen saturation percent",
  "respiratoryRate": "number or null — breaths per minute",
  "temperature": "number or null — body temperature (numeric value only)",

  "consciousnessLevel": "alert|voice|pain|unresponsive or null — AVPU scale. 'awake/conscious/alert'→alert, 'responds to voice/verbal'→voice, 'responds to pain'→pain, 'unconscious/unresponsive/coma'→unresponsive",

  "headInjurySuspected": "boolean or null — true if head injury, head trauma, TBI, or concussion mentioned",
  "seizureActivity": "boolean or null — true if seizure, convulsion, or fitting mentioned",

  "breathingStatus": "normal|labored|assisted|not_breathing or null — 'difficulty breathing/SOB/wheezing'→labored, 'intubated/BVM/ventilator'→assisted, 'apnea/not breathing/respiratory arrest'→not_breathing",
  "chestPainPresent": "boolean or null — true if chest pain, angina, or substernal pain mentioned",
  "cardiacHistoryKnown": "boolean or null — true if known heart disease, cardiac history, or prior MI mentioned",

  "injuryType": "none|fracture|polytrauma|burns|laceration|internal or null — 'broken bone'→fracture, 'multiple injuries'→polytrauma, 'cut/wound/stab'→laceration, 'internal bleeding/blunt trauma'→internal",
  "bleedingSeverity": "none|mild|severe or null — 'heavy/uncontrolled/massive/hemorrhage'→severe, 'minor/controlled/slight'→mild",
  "burnsPercentage": "number 0-100 or null — body surface area with burns. Extract from '25% burns', 'burns coverage 30%', 'thirty percent BSA'",

  "emergencyType": "medical|accident|cardiac|fire|industrial|other or null — 'RTA/crash/collision'→accident, 'heart attack/MI/chest pain'→cardiac, 'fire/smoke inhalation'→fire, 'factory/chemical/electrocution'→industrial",

  "oxygenAdministered": "boolean or null — true if oxygen given, O2 mask applied, nasal cannula mentioned",
  "cprPerformed": "boolean or null — true if CPR, chest compressions, or resuscitation mentioned",
  "ivFluidsStarted": "boolean or null — true if IV, intravenous fluids, normal saline, or drip started",

  "transportPriority": "immediate|urgent|delayed|minor or null — 'priority 1/red/critical/stat'→immediate, 'priority 2/yellow/urgent'→urgent, 'priority 3/green/stable/delayed'→delayed, 'priority 4/white/minor/walking wounded'→minor",
  "ventilatorRequired": "boolean or null — true if ventilator, mechanical ventilation, or intubation required",
  "oxygenRequired": "boolean or null — true if oxygen support or supplemental O2 required during transport",
  "defibrillatorRequired": "boolean or null — true if defibrillator, AED, or shock therapy required",
  "spinalImmobilization": "boolean or null — true if spinal precautions, c-collar, backboard, or neck injury mentioned",

  "suspectedInfectious": "boolean or null — true if infection, fever with suspected disease, TB, COVID, or infectious mentioned",
  "isolationRequired": "boolean or null — true if isolation, quarantine, or barrier precautions mentioned",

  "paramedicNotes": "string or null — any additional clinical observations, medications, allergies, or context not captured above",
  "locationDescription": "string or null — scene description, environmental hazards, or incident location details",

  "confidenceScore": "number 0.0-1.0",
  "missingCriticalFields": ["array of field names that are clinically important but were not mentioned"]
}`;


const SYSTEM_PROMPT = `You are a clinical data extraction AI assistant for emergency medical services.

Listen to the provided audio recording of a paramedic's verbal patient report.

Your task:
1. Transcribe the audio EXACTLY (verbatim, no corrections).
2. Extract the structured clinical data from the transcription.
3. Return ONLY a single JSON object — no markdown, no explanation, no extra text.

JSON schema to return:
${JSON_SCHEMA}

Rules:
- Set fields to null if not mentioned or unclear.
- confidenceScore: 1.0 = all critical fields present and clear, 0.0 = almost nothing captured.
- missingCriticalFields: list fields that are clinically critical but absent (heartRate, spo2, consciousnessLevel, emergencyType).
- Do NOT invent or hallucinate values. Only extract what is clearly stated.`;

// Simple in-memory rate limit: 20 requests per minute per IP
const rateLimitMap = new Map();
function checkRateLimit(ip) {
    const now = Date.now();
    const entry = rateLimitMap.get(ip) || { count: 0, reset: now + 60_000 };
    if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
    entry.count++;
    rateLimitMap.set(ip, entry);
    return entry.count <= 20;
}

function validateExtracted(data) {
    const required = ['transcript', 'confidenceScore', 'missingCriticalFields'];
    return required.every(k => k in data);
}

export default async function handler(req, res) {
    // CORS preflight
    if (req.method === 'OPTIONS') {
        return res.status(204).set(CORS_HEADERS).end();
    }
    Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    const ip = req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
    if (!checkRateLimit(ip)) {
        return res.status(429).json({ success: false, error: 'Rate limit exceeded. Please wait.' });
    }

    const apiKey = process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY;
    if (!apiKey || !apiKey.startsWith('sk-')) {
        return res.status(500).json({ success: false, error: 'OpenAI API key not configured' });
    }

    const { audio, mimeType } = req.body || {};
    if (!audio || typeof audio !== 'string') {
        return res.status(400).json({ success: false, error: 'Missing audio data' });
    }

    // Rough size guard: base64 of 120s audio at 16kbps ≈ 240kB base64 ≈ 320k chars
    if (audio.length > 500_000) {
        return res.status(400).json({ success: false, error: 'Audio too large (max ~60s)' });
    }

    const resolvedMime = mimeType || 'audio/webm';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000); // 30s for audio

    try {
        const llmResponse = await generateContentFromAudio({
            systemPrompt: SYSTEM_PROMPT,
            audioBase64: audio,
            mimeType: resolvedMime,
            temperature: 0.1,
            maxTokens: 2048,
            model: 'gpt-4o-mini'
        });

        const rawText = llmResponse.text || '';

        let parsed;
        try {
            parsed = JSON.parse(rawText.trim());
        } catch {
            // Try to extract JSON from response if extra text present
            const match = rawText.match(/\{[\s\S]*\}/);
            if (!match) {
                return res.status(502).json({ success: false, error: 'AI returned invalid response. Try again.' });
            }
            parsed = JSON.parse(match[0]);
        }

        if (!validateExtracted(parsed)) {
            return res.status(502).json({ success: false, error: 'AI response missing required fields.' });
        }

        // Separate transcript from extractedData
        const { transcript, confidenceScore, missingCriticalFields, ...extractedData } = parsed;

        return res.status(200).json({
            success: true,
            transcript: transcript || '',
            extractedData,
            confidenceScore: typeof confidenceScore === 'number' ? confidenceScore : 0.5,
            missingCriticalFields: Array.isArray(missingCriticalFields) ? missingCriticalFields : [],
        });

    } catch (err) {
        clearTimeout(timeout);
        if (err.name === 'AbortError') {
            return res.status(504).json({ success: false, error: 'Audio processing timed out. Try a shorter recording.' });
        }
        console.error('voice-intake-audio error:', err);
        return res.status(500).json({ success: false, error: 'Internal server error' });
    }
}
