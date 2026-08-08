/**
 * QR Relevance Layer — Clinical Routing Context Builder
 *
 * Responsibility: Determine whether a patient's QR history is clinically
 * relevant to their CURRENT emergency, and produce a ClinicalRoutingContext
 * object that the routing engine can optionally consume.
 *
 * This module knows NOTHING about hospitals, scoring, or routing.
 * It only classifies emergencies and evaluates organ risk relevance.
 *
 * Inputs:  emergencyCase (current emergency), qrData (parsed from QR scan)
 * Output:  ClinicalRoutingContext { applicable, clinicalIntents, explanation, confidence }
 *
 * Design principles:
 *  - Rule-based only. No AI, no LLM, no Firebase.
 *  - Clinical intents are high-level strings — NOT routing engine capability names.
 *  - When applicable is false, the routing engine behaves identically to today.
 *  - When qrData is absent, always returns applicable: false.
 */

// =============================================================================
// EMERGENCY CATEGORY MAPPING
// =============================================================================

/**
 * Maps the incoming emergencyType string to one of 7 clinical categories.
 *
 * This mapping is INDEPENDENT of the routing engine's EMERGENCY_TYPE_ALIAS.
 * The routing engine maps 'stroke' to 'cardiac' for capability scoring purposes.
 * We map 'stroke' to NEUROLOGICAL because that is its clinical reality.
 *
 * Unknown types fall through to UNKNOWN, which triggers ignore rule 7.
 */
const EMERGENCY_CATEGORY = {
    // ── CARDIAC ──────────────────────────────────────────────────────────────
    // Emergencies where the heart is the primary organ under stress.
    cardiac:            'CARDIAC',
    chest_pain:         'CARDIAC',
    heart_attack:       'CARDIAC',
    arrhythmia:         'CARDIAC',
    angina:             'CARDIAC',
    palpitations:       'CARDIAC',

    // ── NEUROLOGICAL ─────────────────────────────────────────────────────────
    // Emergencies where the brain or nervous system is the primary concern.
    stroke:             'NEUROLOGICAL',
    tia:                'NEUROLOGICAL',
    seizure:            'NEUROLOGICAL',
    altered_consciousness: 'NEUROLOGICAL',
    head_injury:        'NEUROLOGICAL',
    neurological:       'NEUROLOGICAL',
    unconscious:        'NEUROLOGICAL',

    // ── RESPIRATORY ──────────────────────────────────────────────────────────
    // Emergencies where breathing capacity is the immediate problem.
    respiratory_distress:   'RESPIRATORY',
    asthma:                 'RESPIRATORY',
    copd:                   'RESPIRATORY',
    pulmonary_embolism:     'RESPIRATORY',
    respiratory:            'RESPIRATORY',
    breathing_difficulty:   'RESPIRATORY',
    shortness_of_breath:    'RESPIRATORY',

    // ── TRAUMA ───────────────────────────────────────────────────────────────
    // Acute physical injury. Historical organ risk is almost never the primary
    // routing concern — the injury itself dominates. Always ignored.
    trauma:                 'TRAUMA',
    accident:               'TRAUMA',
    road_traffic_accident:  'TRAUMA',
    rta:                    'TRAUMA',
    industrial:             'TRAUMA',
    fall:                   'TRAUMA',
    blast:                  'TRAUMA',
    multi_trauma:           'TRAUMA',
    penetrating_trauma:     'TRAUMA',

    // ── RENAL ────────────────────────────────────────────────────────────────
    // Emergencies where kidney function is the primary concern.
    kidney_failure:     'RENAL',
    renal_colic:        'RENAL',
    fluid_overload:     'RENAL',
    renal:              'RENAL',
    urological:         'RENAL',

    // ── HEPATIC / METABOLIC ──────────────────────────────────────────────────
    // Emergencies involving liver function, poisoning, or metabolic crisis.
    // These often have complex multi-organ histories worth considering.
    poisoning:          'HEPATIC_METABOLIC',
    overdose:           'HEPATIC_METABOLIC',
    liver_failure:      'HEPATIC_METABOLIC',
    diabetic_crisis:    'HEPATIC_METABOLIC',
    metabolic:          'HEPATIC_METABOLIC',
    toxic:              'HEPATIC_METABOLIC',
    medical:            'HEPATIC_METABOLIC',  // General medical — conservative

    // ── BURNS / INFECTIOUS ───────────────────────────────────────────────────
    // These emergencies are dominated by burn care or isolation protocols.
    // Organ history is not a useful routing signal here.
    burn:               'BURNS_INFECTIOUS',
    burns:              'BURNS_INFECTIOUS',
    fire:               'BURNS_INFECTIOUS',
    infectious:         'BURNS_INFECTIOUS',
    chemical_exposure:  'BURNS_INFECTIOUS',
    smoke_inhalation:   'BURNS_INFECTIOUS',
    other:              'BURNS_INFECTIOUS',
};

// =============================================================================
// ORGAN SCORE RELEVANCE MATRIX
// =============================================================================

/**
 * For each emergency category, defines which organ scores from the QR are
 * clinically relevant and at what minimum threshold they must reach.
 *
 * Tier definitions:
 *  PRIMARY   (threshold 70): Emergency directly involves this organ system.
 *                             History is directly clinically relevant.
 *  SECONDARY (threshold 80): Organ system could complicate treatment or recovery.
 *                             History is cautionary context. Higher bar required.
 *
 * Why separate thresholds:
 *  A patient with heartRisk 75 presenting with chest pain has a clearly relevant
 *  cardiac history (PRIMARY fires at 70). The same score on a patient presenting
 *  with stroke is only cautionary context — we require 80 before treating it as
 *  significant enough to influence routing (SECONDARY threshold).
 */
const PRIMARY_THRESHOLD   = 70;
const SECONDARY_THRESHOLD = 80;

const RELEVANCE_MATRIX = {
    CARDIAC: {
        // Heart is the directly implicated organ. History is highly relevant.
        primary:   [{ organ: 'heartRisk',  intent: 'advanced_cardiology' }],
        // Pulmonary complications are common co-morbidities in cardiac patients.
        secondary: [{ organ: 'lungsRisk',  intent: 'advanced_respiratory' }],
    },
    NEUROLOGICAL: {
        // Brain is the directly implicated organ.
        primary:   [{ organ: 'brainRisk',  intent: 'advanced_neurology' }],
        // Cardiac history matters — AF and hypertension are stroke risk factors.
        secondary: [{ organ: 'heartRisk',  intent: 'advanced_cardiology' }],
    },
    RESPIRATORY: {
        // Lungs are the directly implicated organ.
        primary:   [{ organ: 'lungsRisk',  intent: 'advanced_respiratory' }],
        // Cardiac disease is the most common respiratory co-morbidity.
        secondary: [{ organ: 'heartRisk',  intent: 'advanced_cardiology' }],
    },
    RENAL: {
        // Kidneys are the directly implicated organ.
        primary:   [{ organ: 'kidneyRisk', intent: 'advanced_renal' }],
        // Cardiac disease is the leading cause of renal co-morbidity.
        secondary: [{ organ: 'heartRisk',  intent: 'advanced_cardiology' }],
    },
    HEPATIC_METABOLIC: {
        // Liver is the primary organ in these emergencies.
        primary:   [{ organ: 'liverRisk',  intent: 'advanced_hepatic' }],
        // Encephalopathy and metabolic brain involvement are common.
        secondary: [
            { organ: 'brainRisk',  intent: 'advanced_neurology' },
            { organ: 'kidneyRisk', intent: 'advanced_renal' },
        ],
    },
    // TRAUMA and BURNS_INFECTIOUS have no relevance entries.
    // They are handled entirely by ignore rules before reaching this matrix.
};

// =============================================================================
// IGNORE RULES
// =============================================================================

/**
 * Ignore rules are evaluated IN ORDER before the relevance matrix is consulted.
 * If any rule fires, buildClinicalRoutingContext() returns { applicable: false }
 * immediately, and the routing engine runs exactly as it does today.
 *
 * Rules are ordered from cheapest to most expensive to evaluate.
 */

/**
 * Rule 1 — No QR data present.
 * Rationale: Nothing to evaluate. This is the most common path when no QR is
 * scanned. Must never throw.
 */
function ignoreRule1_noData(qrData) {
    return !qrData || typeof qrData !== 'object';
}

/**
 * Rule 2 — Emergency category is TRAUMA.
 * Rationale: Acute trauma is dominated by the injury itself — hemorrhage control,
 * surgical access, and orthopedic capability. Historical organ risk (e.g. heartRisk
 * 95 in an RTA patient) does not change which trauma center should receive the
 * patient. Routing toward a cardiac center in a trauma case is clinically dangerous.
 *
 * This rule is absolute. TRAUMA always returns applicable: false.
 */
function ignoreRule2_traumaCategory(category) {
    return category === 'TRAUMA';
}

/**
 * Rule 3 — Emergency category is BURNS or INFECTIOUS.
 * Rationale: Burn care is governed by surface area, depth, and burn specialist
 * availability. Infectious disease routing is governed by isolation capacity.
 * Neither is meaningfully influenced by the patient's pre-existing organ risks.
 */
function ignoreRule3_burnsInfectious(category) {
    return category === 'BURNS_INFECTIOUS';
}

// Rule 4 (overallRisk < 40 gate) was intentionally removed.
// Applicability is determined solely by emergency category and organ score
// thresholds in the relevance matrix. An aggregate risk score should not
// suppress clinically significant individual organ history.

/**
 * Rule 5 — All organ scores are below 50.
 * Rationale: If no organ system shows elevated historical risk, the QR data
 * contributes nothing clinically meaningful to the routing decision.
 */
function ignoreRule5_allScoresLow(qrData) {
    const scores = [
        safeOrganScore(qrData.heartRisk),
        safeOrganScore(qrData.lungsRisk),
        safeOrganScore(qrData.brainRisk),
        safeOrganScore(qrData.liverRisk),
        safeOrganScore(qrData.kidneyRisk),
    ];
    return scores.every(s => s < 50);
}

/**
 * Rule 6 — Emergency category is UNKNOWN (not in the mapping).
 * Rationale: An unrecognised emergency type cannot be classified. We cannot
 * determine which organ systems are relevant, so no history is applied.
 * This prevents silent misclassification.
 */
function ignoreRule6_unknownCategory(category) {
    return !category || category === 'UNKNOWN';
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Safely extract an organ risk score.
 * Returns 0 for null, undefined, non-numeric, or NaN values.
 * Clamps to [0, 100].
 */
function safeOrganScore(value) {
    if (value === null || value === undefined) return 0;
    const n = typeof value === 'number' ? value : parseFloat(value);
    if (isNaN(n) || !isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
}

/**
 * Resolve the emergency type string to one of the 7 clinical categories.
 * Normalises the input: lowercase, trims whitespace, replaces spaces with
 * underscores so callers do not need to pre-format the type string.
 */
function resolveCategory(emergencyCase) {
    const raw = emergencyCase?.emergencyContext?.emergencyType
        || emergencyCase?.emergencyType
        || '';

    const normalised = raw.toLowerCase().trim().replace(/\s+/g, '_');
    return EMERGENCY_MATRIX_LOOKUP(normalised);
}

/**
 * Internal category lookup with fallback.
 * Returns 'UNKNOWN' for unrecognised types.
 */
function EMERGENCY_MATRIX_LOOKUP(normalisedType) {
    return EMERGENCY_CATEGORY[normalisedType] || 'UNKNOWN';
}

/**
 * Determine confidence level from the tiers that fired.
 *  high   = at least one PRIMARY intent matched
 *  medium = only SECONDARY intents matched
 *  low    = reserved (no current path produces low — retained for future sources)
 */
function resolveConfidence(primaryFired, secondaryFired) {
    if (primaryFired) return 'high';
    if (secondaryFired) return 'medium';
    return 'low';
}

// =============================================================================
// CORE RELEVANCE EVALUATION
// =============================================================================

/**
 * Evaluate the relevance matrix for the resolved category.
 * Returns the set of clinical intents that should be enhanced in routing,
 * plus which tiers fired (for confidence calculation).
 *
 * Deduplication: a clinical intent can appear in both primary and secondary.
 * It is only added once, at the higher tier's influence level.
 */
function evaluateMatrix(category, qrData) {
    const matrixEntry = RELEVANCE_MATRIX[category];

    // No matrix entry → no intents (covers TRAUMA, BURNS_INFECTIOUS if not
    // caught by ignore rules — defensive fallback).
    if (!matrixEntry) {
        return { intents: [], explanation: [], primaryFired: false, secondaryFired: false };
    }

    const intents = [];
    const explanation = [];
    let primaryFired = false;
    let secondaryFired = false;
    const seen = new Set();

    // Evaluate PRIMARY tier
    (matrixEntry.primary || []).forEach(({ organ, intent }) => {
        const score = safeOrganScore(qrData[organ]);
        if (score >= PRIMARY_THRESHOLD && !seen.has(intent)) {
            seen.add(intent);
            intents.push(intent);
            primaryFired = true;
            explanation.push(
                `Historical ${formatOrganName(organ)} is elevated (${score}/100) — ${formatIntent(intent)} prioritised.`
            );
        }
    });

    // Evaluate SECONDARY tier
    (matrixEntry.secondary || []).forEach(({ organ, intent }) => {
        const score = safeOrganScore(qrData[organ]);
        if (score >= SECONDARY_THRESHOLD && !seen.has(intent)) {
            seen.add(intent);
            intents.push(intent);
            secondaryFired = true;
            explanation.push(
                `Historical ${formatOrganName(organ)} is significantly elevated (${score}/100) — ${formatIntent(intent)} considered as complication risk.`
            );
        }
    });

    return { intents, explanation, primaryFired, secondaryFired };
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * buildClinicalRoutingContext
 *
 * The single exported function. Converts QR organ history and current emergency
 * context into a ClinicalRoutingContext object.
 *
 * @param {object} emergencyCase  - The current emergency case object
 * @param {object|null} qrData    - Parsed QR payload, or null/undefined if no QR scanned
 * @returns {ClinicalRoutingContext}
 *
 * ClinicalRoutingContext shape:
 * {
 *   applicable:      boolean          — true = routing engine should use this
 *   clinicalIntents: string[]         — high-level clinical enhancement signals
 *   explanation:     string[]         — human-readable reason per decision
 *   confidence:      'high'|'medium'|'low'
 * }
 *
 * When applicable is false, the routing engine behaves identically to today.
 * This function NEVER throws. It NEVER returns null.
 */
export function buildClinicalRoutingContext(emergencyCase, qrData) {
    // ── IGNORE RULE 1: No QR data ─────────────────────────────────────────────
    if (ignoreRule1_noData(qrData)) {
        return notApplicable('No patient QR history available. Standard routing applied.');
    }


    // ── IGNORE RULE 5: All organ scores below threshold ───────────────────────
    if (ignoreRule5_allScoresLow(qrData)) {
        return notApplicable('No organ system shows elevated historical risk. Standard routing applied.');
    }

    // ── Resolve emergency category ─────────────────────────────────────────────
    const category = resolveCategory(emergencyCase);

    // ── IGNORE RULE 6: Unknown emergency type ─────────────────────────────────
    if (ignoreRule6_unknownCategory(category)) {
        return notApplicable(
            'Emergency type could not be classified. Historical data not applied.'
        );
    }

    // ── IGNORE RULE 2: Trauma category ────────────────────────────────────────
    if (ignoreRule2_traumaCategory(category)) {
        return notApplicable(
            'Acute trauma emergency — current injury takes priority over organ history. ' +
            'Standard trauma routing applied.'
        );
    }

    // ── IGNORE RULE 3: Burns or infectious ────────────────────────────────────
    if (ignoreRule3_burnsInfectious(category)) {
        return notApplicable(
            'Burns or infectious emergency — specialist isolation capability governs routing. ' +
            'Organ history not applied.'
        );
    }

    // ── Evaluate organ relevance matrix ───────────────────────────────────────
    const { intents, explanation, primaryFired, secondaryFired } =
        evaluateMatrix(category, qrData);

    // ── Post-matrix ignore: no relevant scores met their threshold ────────────
    // The emergency type was classifiable, but none of the relevant organ scores
    // were high enough to trigger an enhancement.
    if (intents.length === 0) {
        return notApplicable(
            'Relevant organ risk scores are below influence threshold for this emergency. ' +
            'Standard routing applied.'
        );
    }

    // ── Applicable: build and return context ──────────────────────────────────
    const confidence = resolveConfidence(primaryFired, secondaryFired);

    return {
        applicable:      true,
        clinicalIntents: intents,
        explanation:     explanation,
        confidence:      confidence,
    };
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

/**
 * Construct a standardised "not applicable" result.
 * The routing engine treats applicable:false as a no-op.
 */
function notApplicable(reason) {
    return {
        applicable:      false,
        clinicalIntents: [],
        explanation:     [reason],
        confidence:      'low',
    };
}

/**
 * Format an organ field name into a readable label for explanations.
 */
function formatOrganName(organ) {
    const map = {
        heartRisk:   'cardiac risk',
        lungsRisk:   'pulmonary risk',
        brainRisk:   'neurological risk',
        liverRisk:   'hepatic risk',
        kidneyRisk:  'renal risk',
    };
    return map[organ] || organ;
}

/**
 * Format a clinical intent into a readable label for explanations.
 */
function formatIntent(intent) {
    const map = {
        advanced_cardiology:  'advanced cardiology capability',
        advanced_neurology:   'advanced neurology capability',
        advanced_respiratory: 'advanced respiratory capability',
        advanced_renal:       'advanced renal capability',
        advanced_hepatic:     'advanced hepatic/metabolic capability',
    };
    return map[intent] || intent;
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
    buildClinicalRoutingContext,
};
