/**
 * /api/triage/index.js — AI Vital-Sign Triage Engine
 *
 * Serverless endpoint implementing START/SALT triage using GPT-5 mini.
 * Returns strict JSON — no free text output allowed.
 * Falls back to local rule-based triage if AI fails.
 *
 * POST /api/triage
 */

import { generateContent } from '../utils/llmClient.js';

// ─── Rate limiting (in-memory, resets on cold start) ───────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_MAX = 10;       // max calls per window
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute

function isRateLimited(ip) {
    const now = Date.now();
    const entry = rateLimitMap.get(ip);
    if (!entry || now > entry.resetAt) {
        rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return false;
    }
    entry.count += 1;
    if (entry.count > RATE_LIMIT_MAX) return true;
    rateLimitMap.set(ip, entry);
    return false;
}

// ─── Sanitize string inputs to prevent prompt injection ────────────────────
function sanitizeString(value, maxLen = 200) {
    if (typeof value !== 'string') return '';
    return value.replace(/[`'"\\]/g, '').slice(0, maxLen);
}

function sanitizeNumber(value) {
    const n = parseFloat(value);
    return isNaN(n) ? null : n;
}

// ─── Ambulance type recommendation based on acuity level ──────────────────
function getAmbulanceType(acuityLevel) {
    const map = {
        1: 'ICU Ambulance',
        2: 'Trauma Ambulance',
        3: 'Cardiac Ambulance',
        4: 'Basic Ambulance',
        5: 'Basic Ambulance',
    };
    return map[acuityLevel] || 'Basic Ambulance';
}

// ─── Local fallback triage (START/SALT rules) ──────────────────────────────
function runFallbackTriage(vitals) {
    const {
        spo2, heartRate, respiratoryRate, systolicBP,
        consciousnessLevel, breathingStatus, bleedingSeverity,
        cprPerformed, burnsPercentage
    } = vitals;

    const flags = [];

    // Level 1 — IMMEDIATE (life-threatening)
    if (cprPerformed) { flags.push('CPR in progress'); return buildFallback(1, 'Immediate', flags, 90); }
    if (spo2 !== null && spo2 < 85) { flags.push('SpO2 < 85% — severe hypoxia'); }
    if (systolicBP !== null && systolicBP < 90) { flags.push('SBP < 90 mmHg — hemodynamic instability'); }
    if (consciousnessLevel === 'unresponsive') { flags.push('Unresponsive — AVPU = U'); }
    if (breathingStatus === 'not_breathing') { flags.push('Apnea detected'); }
    if (flags.length > 0) return buildFallback(1, 'Immediate', flags, 85);

    // Level 2 — CRITICAL (high risk)
    if (heartRate !== null && heartRate > 130) flags.push('Tachycardia > 130 bpm');
    if (heartRate !== null && heartRate < 50) flags.push('Severe bradycardia < 50 bpm');
    if (respiratoryRate !== null && respiratoryRate > 30) flags.push('Tachypnea > 30 breaths/min');
    if (spo2 !== null && spo2 < 92) flags.push('SpO2 < 92% — significant hypoxia');
    if (consciousnessLevel === 'pain') flags.push('Only responding to pain — AVPU = P');
    if (bleedingSeverity === 'severe') flags.push('Severe hemorrhage');
    if (burnsPercentage > 30) flags.push(`Burns > 30% body surface (${burnsPercentage}%)`);
    if (flags.length > 0) return buildFallback(2, 'Critical', flags, 80);

    // Level 3 — URGENT
    const urgentFlags = [];
    if (heartRate !== null && (heartRate > 100 || heartRate < 60)) urgentFlags.push('Abnormal heart rate');
    if (respiratoryRate !== null && (respiratoryRate > 20 || respiratoryRate < 12)) urgentFlags.push('Abnormal respiratory rate');
    if (spo2 !== null && spo2 < 95) urgentFlags.push('SpO2 < 95%');
    if (consciousnessLevel === 'verbal') urgentFlags.push('Only responding to verbal stimuli');
    if (bleedingSeverity === 'mild') urgentFlags.push('Mild hemorrhage');
    if (urgentFlags.length > 0) return buildFallback(3, 'Urgent', urgentFlags, 75);

    // Level 4 — DELAYED
    return buildFallback(4, 'Delayed', ['No immediately life-threatening findings detected'], 70);
}

function buildFallback(level, label, flags, confidence) {
    return {
        acuity_level: level,
        severity_label: label,
        confidence,
        clinical_flags: flags,
        reasoning_summary: `Rule-based triage (fallback): ${label}. ${flags.join('; ')}.`,
        source: 'fallback_rules',
        ambulanceType: getAmbulanceType(level),
    };
}

// ─── SAFETY DOMINANCE: AI cannot downgrade below rule-based floor ──────────
// Called on every Gemini result. Rule-based severity is the hard floor.
// Lower acuity_level number = MORE severe (1=Immediate, 5=Minor).
function applySafetyDominance(geminiResult, safe) {
    const rulesResult = runFallbackTriage(safe);

    // If rule-based is MORE severe (lower number), override AI result
    if (rulesResult.acuity_level < geminiResult.acuity_level) {
        const overriddenFlags = [
            ...rulesResult.clinical_flags,
            `[Safety Override] AI returned Level ${geminiResult.acuity_level} (${geminiResult.severity_label}) — upgraded to rule-based floor`
        ];
        return {
            ...geminiResult,
            acuity_level: rulesResult.acuity_level,
            severity_label: rulesResult.severity_label,
            clinical_flags: overriddenFlags,
            reasoning_summary: `Safety dominance applied: rule-based floor (${rulesResult.severity_label}) overrides AI result (${geminiResult.severity_label}). ${rulesResult.reasoning_summary}`,
            source: 'gemini_safety_override',
            safety_override: true,
            ai_original_level: geminiResult.acuity_level,
        };
    }

    // AI result is equal or more severe than rules — keep AI result
    return { ...geminiResult, safety_override: false };
}

// ─── Validate Gemini output schema ─────────────────────────────────────────
const VALID_LABELS = ['Immediate', 'Critical', 'Urgent', 'Delayed', 'Minor'];

function validateTriageResponse(parsed) {
    if (typeof parsed !== 'object' || parsed === null) {
        console.error('[TRIAGE DEBUG] Validation fail: parsed is not an object', typeof parsed);
        return false;
    }
    if (parsed.error === 'insufficient_data') return true;

    const level = parsed.acuity_level;
    if (typeof level !== 'number' || level < 1 || level > 5) {
        console.error('[TRIAGE DEBUG] Validation fail: acuity_level invalid', level, typeof level);
        // Auto-fix: Gemini sometimes returns string "2" instead of number 2
        if (typeof level === 'string') {
            const n = parseInt(level, 10);
            if (n >= 1 && n <= 5) { parsed.acuity_level = n; }
            else return false;
        } else return false;
    }
    if (!VALID_LABELS.includes(parsed.severity_label)) {
        console.error('[TRIAGE DEBUG] Validation fail: severity_label invalid', parsed.severity_label);
        // Auto-fix: case mismatch (e.g. "immediate" → "Immediate")
        const fixed = VALID_LABELS.find(l => l.toLowerCase() === (parsed.severity_label || '').toLowerCase());
        if (fixed) { parsed.severity_label = fixed; }
        else return false;
    }
    if (typeof parsed.confidence !== 'number') {
        console.error('[TRIAGE DEBUG] Validation fail: confidence not a number', parsed.confidence, typeof parsed.confidence);
        // Auto-fix: string or float
        const c = parseFloat(parsed.confidence);
        if (!isNaN(c)) { parsed.confidence = Math.round(c); }
        else return false;
    }
    if (!Array.isArray(parsed.clinical_flags)) {
        console.error('[TRIAGE DEBUG] Validation fail: clinical_flags not array', parsed.clinical_flags);
        // Auto-fix: if it's a string, wrap in array
        if (typeof parsed.clinical_flags === 'string') { parsed.clinical_flags = [parsed.clinical_flags]; }
        else { parsed.clinical_flags = []; }
    }
    if (typeof parsed.reasoning_summary !== 'string') {
        console.error('[TRIAGE DEBUG] Validation fail: reasoning_summary not string', typeof parsed.reasoning_summary);
        parsed.reasoning_summary = String(parsed.reasoning_summary || 'AI triage analysis result');
    }
    return true;
}

// ─── START/SALT system prompt ──────────────────────────────────────────────
function buildTriageSystemPrompt() {
    return `You are a clinical triage classification AI operating strictly within the START (Simple Triage and Rapid Treatment) and SALT (Sort, Assess, Lifesaving Interventions, Treatment/Transport) triage protocols.

ABSOLUTE RULES:
1. You MUST return ONLY a valid JSON object. No prose, no markdown, no explanation outside the JSON.
2. You MUST NOT diagnose any disease or condition.
3. You MUST NOT recommend treatment or medications.
4. You MUST NOT override human clinical judgment.
5. You MUST classify ONLY based on the vital threshold rules below.
6. If insufficient vitals are provided for classification, return: {"error":"insufficient_data"}

ACUITY CLASSIFICATION RULES (START/SALT):
- Level 1 (Immediate): Meets ANY of: respiratory rate <10 or >30, SpO2 <88%, SBP <90 mmHg, unresponsive (AVPU=U), not breathing, CPR in progress, severe hemorrhage with shock
- Level 2 (Critical): Meets ANY of: HR >130 or <50, SpO2 88-91%, RR 25-30, responds only to pain (AVPU=P), burns >25% BSA, severe uncontrolled bleeding
- Level 3 (Urgent): Altered vitals without immediate life threat — HR 100-130, SpO2 92-94%, RR 20-25, responds to verbal (AVPU=V), moderate bleeding
- Level 4 (Delayed): Stable vitals — HR 60-100, SpO2 ≥95%, RR 12-20, alert (AVPU=A), no bleeding or minor bleeding
- Level 5 (Minor): Ambulatory, no significant vital sign abnormality, minor injury only

REQUIRED OUTPUT SCHEMA (strict JSON only):
{
  "acuity_level": <integer 1-5>,
  "severity_label": <"Immediate" | "Critical" | "Urgent" | "Delayed" | "Minor">,
  "confidence": <integer 0-100>,
  "clinical_flags": [<array of string — each is a specific triggered threshold rule>],
  "reasoning_summary": <string max 150 chars — plain medical rationale, no diagnosis>
}

CONFIDENCE SCORING:
- 90-100: ≥3 vital parameters available, clear threshold breach
- 70-89: 2 vital parameters, borderline reading
- 50-69: 1 vital parameter or incomplete data
- <50: Insufficient data — replace with {"error":"insufficient_data"}

DO NOT include any text before or after the JSON object.`;
}

// ─── Main handler ──────────────────────────────────────────────────────────
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    // ── Rate limiting ────────────────────────────────────────────────────────
    const clientIP = req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || 'unknown';
    if (isRateLimited(clientIP)) {
        return res.status(429).json({ success: false, error: 'Rate limit exceeded. Max 10 triage calls per minute.' });
    }

    // ── Parse body ───────────────────────────────────────────────────────────
    let body;
    try {
        if (Buffer.isBuffer(req.body)) body = JSON.parse(req.body.toString('utf-8'));
        else if (typeof req.body === 'string') body = JSON.parse(req.body);
        else if (typeof req.body === 'object') body = req.body;
        else throw new Error('Invalid body type');
    } catch {
        return res.status(400).json({ success: false, error: 'Invalid request body' });
    }

    const { vitals } = body;
    if (!vitals || typeof vitals !== 'object') {
        return res.status(400).json({ success: false, error: 'vitals object is required' });
    }

    // ── Sanitize inputs ──────────────────────────────────────────────────────
    const safe = {
        heartRate: sanitizeNumber(vitals.heartRate),
        spo2: sanitizeNumber(vitals.spo2),
        respiratoryRate: sanitizeNumber(vitals.respiratoryRate),
        systolicBP: sanitizeNumber((vitals.bloodPressure || '').toString().split('/')[0]),
        diastolicBP: sanitizeNumber((vitals.bloodPressure || '').toString().split('/')[1]),
        temperature: sanitizeNumber(vitals.temperature),
        temperatureUnit: sanitizeString(vitals.temperatureUnit || 'celsius', 20),
        consciousnessLevel: sanitizeString(vitals.consciousnessLevel || '', 30),
        breathingStatus: sanitizeString(vitals.breathingStatus || '', 30),
        bleedingSeverity: sanitizeString(vitals.bleedingSeverity || '', 20),
        injuryType: sanitizeString(vitals.injuryType || '', 30),
        burnsPercentage: sanitizeNumber(vitals.burnsPercentage) || 0,
        cprPerformed: Boolean(vitals.cprPerformed),
        emergencyType: sanitizeString(vitals.emergencyType || '', 30),
        gender: sanitizeString(vitals.gender || '', 10),
        age: sanitizeNumber(vitals.age),
        chestPainPresent: Boolean(vitals.chestPainPresent),
        headInjurySuspected: Boolean(vitals.headInjurySuspected),
        seizureActivity: Boolean(vitals.seizureActivity),
    };

    // Check minimum viable vitals for Gemini call
    const hasMinVitals = safe.heartRate !== null || safe.spo2 !== null || safe.respiratoryRate !== null;

    // ── API key ───────────────────────────────────────────────────────────────
    const API_KEY = process.env.OPENAI_API_KEY || process.env.VITE_OPENAI_API_KEY;
    if (!API_KEY || !API_KEY.startsWith('sk-')) {
        // Fall back to local rules
        const fallback = runFallbackTriage(safe);
        return res.status(200).json({ success: true, triage: { ...fallback, source: 'fallback_no_api_key' } });
    }

    // ── Skip Gemini if no useful vitals ──────────────────────────────────────
    if (!hasMinVitals) {
        return res.status(200).json({
            success: true,
            triage: { error: 'insufficient_data' }
        });
    }

    // ── Build Gemini prompt ───────────────────────────────────────────────────
    const vitalsText = [
        `Emergency Type: ${safe.emergencyType || 'unknown'}`,
        `Age: ${safe.age ?? 'not provided'}, Gender: ${safe.gender || 'not provided'}`,
        `Heart Rate: ${safe.heartRate ?? 'not provided'} bpm`,
        `SpO2: ${safe.spo2 ?? 'not provided'}%`,
        `Respiratory Rate: ${safe.respiratoryRate ?? 'not provided'} breaths/min`,
        `Blood Pressure: ${safe.systolicBP ?? 'not provided'}/${safe.diastolicBP ?? 'not provided'} mmHg`,
        `Temperature: ${safe.temperature ?? 'not provided'} ${safe.temperatureUnit}`,
        `Consciousness Level (AVPU): ${safe.consciousnessLevel || 'not provided'}`,
        `Breathing Status: ${safe.breathingStatus || 'not provided'}`,
        `Bleeding Severity: ${safe.bleedingSeverity || 'none'}`,
        `Injury Type: ${safe.injuryType || 'none'}`,
        `Burns Coverage: ${safe.burnsPercentage}% BSA`,
        `CPR in Progress: ${safe.cprPerformed ? 'YES' : 'No'}`,
        `Chest Pain: ${safe.chestPainPresent ? 'Yes' : 'No'}`,
        `Head Injury Suspected: ${safe.headInjurySuspected ? 'Yes' : 'No'}`,
        `Seizure Activity: ${safe.seizureActivity ? 'Yes' : 'No'}`,
    ].join('\n');

    // ── Call API ───────────────────────────────────────────────────────────
    try {
        console.log('[TRIAGE DEBUG] Calling AI Model');
        console.log('[TRIAGE DEBUG] Sanitized vitals:', JSON.stringify(safe));

        const llmResponse = await generateContent({
            systemPrompt: buildTriageSystemPrompt(),
            messages: [
                { role: 'model', parts: [{ text: 'Understood. I will return only valid JSON triage classification based on START/SALT protocol.' }] },
                { role: 'user', parts: [{ text: `PATIENT VITALS FOR TRIAGE CLASSIFICATION:\n\n${vitalsText}\n\nReturn JSON only.` }] }
            ],
            maxTokens: 300,
            responseFormat: 'json',
            model: 'gpt-4o-mini'
        });

        const rawText = llmResponse.text || '';

        console.log('[TRIAGE DEBUG] Raw AI response text:', rawText.slice(0, 600));

        if (!rawText) {
            console.error('[TRIAGE DEBUG] Empty response.');
            throw new Error(`Empty AI response.`);
        }

        // Extract JSON from response
        let parsed;
        try {
            parsed = JSON.parse(rawText.trim());
        } catch (parseErr) {
            console.error('[TRIAGE DEBUG] Direct JSON.parse failed:', parseErr.message);
            // Try extracting JSON from markdown wrapper
            const jsonMatch = rawText.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                console.error('[TRIAGE DEBUG] No JSON object found in response at all');
                throw new Error('No JSON found in AI response');
            }
            parsed = JSON.parse(jsonMatch[0]);
        }

        console.log('[TRIAGE DEBUG] Parsed JSON:', JSON.stringify(parsed));

        if (!validateTriageResponse(parsed)) {
            console.error('[TRIAGE DEBUG] Schema validation FAILED after auto-fix attempts');
            throw new Error('AI returned invalid triage schema');
        }

        console.log('[TRIAGE DEBUG] ✅ Validation passed. source=gemini');

        // ── SAFETY DOMINANCE: Rule-based floor always wins ──────────────────
        const dominantResult = applySafetyDominance({ ...parsed, source: 'ai' }, safe);
        // Attach ambulance type recommendation
        dominantResult.ambulanceType = getAmbulanceType(dominantResult.acuity_level);

        console.log('[TRIAGE DEBUG] Final result:', JSON.stringify({ level: dominantResult.acuity_level, source: dominantResult.source, override: dominantResult.safety_override, ambulanceType: dominantResult.ambulanceType }));

        return res.status(200).json({
            success: true,
            triage: dominantResult
        });

    } catch (err) {
        // Any AI failure → fall back to local rules
        console.error('[TRIAGE DEBUG] ❌ AI triage FAILED:', err.message);
        console.error('[TRIAGE DEBUG] Stack:', err.stack?.split('\n').slice(0, 3).join(' | '));
        const fallback = runFallbackTriage(safe);
        return res.status(200).json({
            success: true,
            triage: { ...fallback, source: 'fallback_rules', fallbackReason: err.message }
        });
    }
}
