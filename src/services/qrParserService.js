/**
 * QR Parser Service
 * Responsibilities: Parse and validate QR payload for patient history.
 */

export function parsePatientQR(scannedString) {
    if (!scannedString || typeof scannedString !== 'string') {
        return { valid: false, error: 'Empty or invalid QR format', data: null };
    }

    try {
        const rawData = JSON.parse(scannedString);
        
        // Support both Aura Health QR schema and flat schema
        const scores = rawData.clinical_scores || {};

        const normalizedData = {
            // Aura Health uses "patient_name"; flat schema uses "name"
            name: rawData.patient_name || rawData.name || null,
            age: typeof rawData.age === 'number' ? rawData.age : parseInt(rawData.age, 10) || null,
            gender: rawData.gender ? String(rawData.gender).toLowerCase() : null,
            // Aura Health nests scores under clinical_scores.{heart,kidneys,liver,lungs,brain}
            // Flat schema uses heartRisk, kidneyRisk, etc.
            overallRisk: parseRiskScore(rawData.overallRisk || scores.overall),
            heartRisk:   parseRiskScore(scores.heart   ?? rawData.heartRisk),
            lungsRisk:   parseRiskScore(scores.lungs   ?? rawData.lungsRisk),
            brainRisk:   parseRiskScore(scores.brain   ?? rawData.brainRisk),
            liverRisk:   parseRiskScore(scores.liver   ?? rawData.liverRisk),
            // Aura Health uses "kidneys" (plural); flat schema uses "kidneyRisk"
            kidneyRisk:  parseRiskScore(scores.kidneys ?? scores.kidney ?? rawData.kidneyRisk),
            medications: Array.isArray(rawData.medications) ? rawData.medications.map(String) : []
        };

        return { valid: true, error: null, data: normalizedData };
    } catch (e) {
        return { valid: false, error: 'Malformed QR payload - Invalid JSON', data: null };
    }
}

/**
 * Safely parse a risk score from 0-100
 */
function parseRiskScore(score) {
    if (score === null || score === undefined) return 0;
    const parsed = parseInt(score, 10);
    if (isNaN(parsed)) return 0;
    return Math.max(0, Math.min(100, parsed));
}
