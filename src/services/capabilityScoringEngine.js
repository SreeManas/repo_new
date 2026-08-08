/**
 * Hospital Capability Scoring Engine v2.0
 * 
 * AI-powered decision intelligence for ambulance triage and smart hospital routing.
 * Features: Emergency-specific profiles, golden hour modifier, disqualification 
 * safeguards, equipment penalties, and tie-breaker logic.
 * 
 * Design: Explainable, modular, and ML-upgrade ready.
 */

// =============================================================================
// WEIGHT CONFIGURATION (Acuity-Based)
// =============================================================================

const WEIGHT_PROFILES = {
    critical: {  // acuity >= 4
        capability: 0.60, distance: 0.15, beds: 0.10,
        specialists: 0.10, equipment: 0.03, load: 0.02
    },
    moderate: {  // acuity 3
        capability: 0.40, distance: 0.25, beds: 0.15,
        specialists: 0.10, equipment: 0.05, load: 0.05
    },
    minor: {     // acuity <= 2
        capability: 0.25, distance: 0.50, beds: 0.10,
        specialists: 0.05, equipment: 0.05, load: 0.05
    }
};

// =============================================================================
// EMERGENCY-SPECIFIC SCORING PROFILES
// =============================================================================

const EMERGENCY_PROFILES = {
    cardiac: {
        caseAcceptance: 'acceptsCardiac',
        specialists: ['cardiologist'],
        specialistWeights: { cardiologist: 1.5 },  // Higher weight
        capabilities: ['strokeCenter', 'emergencySurgery'],
        capabilityScores: { strokeCenter: 20, emergencySurgery: 15 },
        equipment: ['defibrillator'],
        equipmentScores: { defibrillator: { present: 25, absent: -40 } },
        bedTypes: ['icu', 'emergency'],
        criticalBeds: ['icu'],  // Must have for critical cases
        traumaLevelBonus: false
    },
    trauma: {
        caseAcceptance: 'acceptsTrauma',
        specialists: ['traumaSurgeon', 'radiologist'],
        specialistWeights: { traumaSurgeon: 2.0, radiologist: 1.0 },
        capabilities: ['emergencySurgery', 'ctScanAvailable'],
        capabilityScores: { emergencySurgery: 25, ctScanAvailable: 15 },
        equipment: ['ventilator', 'portableXRay'],
        equipmentScores: {
            ventilator: { present: 20, absent: -30 },
            portableXRay: { present: 10, absent: -10 }
        },
        bedTypes: ['traumaBeds', 'icu', 'emergency'],
        criticalBeds: ['traumaBeds', 'icu'],
        traumaLevelBonus: true,
        traumaLevelScores: { level_1: 30, level_2: 18, level_3: 8, none: 0 }
    },
    burn: {
        caseAcceptance: 'acceptsBurns',
        specialists: ['burnSpecialist'],
        specialistWeights: { burnSpecialist: 2.5 },
        capabilities: ['emergencySurgery'],
        capabilityScores: { emergencySurgery: 20 },
        equipment: ['ventilator'],
        equipmentScores: { ventilator: { present: 20, absent: -35 } },
        bedTypes: ['icu', 'isolationBeds', 'emergency'],
        criticalBeds: ['isolationBeds'],
        traumaLevelBonus: false
    },
    medical: {
        caseAcceptance: 'acceptsCardiac',
        specialists: ['pulmonologist', 'cardiologist'],
        specialistWeights: { pulmonologist: 1.2, cardiologist: 1.0 },
        capabilities: ['ctScanAvailable', 'mriAvailable'],
        capabilityScores: { ctScanAvailable: 15, mriAvailable: 10 },
        equipment: ['ventilator'],
        equipmentScores: { ventilator: { present: 15, absent: -20 } },
        bedTypes: ['icu', 'emergency'],
        criticalBeds: ['icu'],
        traumaLevelBonus: false
    },
    accident: {
        caseAcceptance: 'acceptsTrauma',
        specialists: ['traumaSurgeon', 'radiologist'],
        specialistWeights: { traumaSurgeon: 1.8, radiologist: 1.0 },
        capabilities: ['emergencySurgery', 'ctScanAvailable'],
        capabilityScores: { emergencySurgery: 22, ctScanAvailable: 12 },
        equipment: ['portableXRay', 'ventilator'],
        equipmentScores: {
            portableXRay: { present: 12, absent: -15 },
            ventilator: { present: 15, absent: -25 }
        },
        bedTypes: ['traumaBeds', 'emergency'],
        criticalBeds: ['traumaBeds'],
        traumaLevelBonus: true,
        traumaLevelScores: { level_1: 25, level_2: 15, level_3: 6, none: 0 }
    },
    fire: {
        caseAcceptance: 'acceptsBurns',
        specialists: ['burnSpecialist', 'pulmonologist'],
        specialistWeights: { burnSpecialist: 2.0, pulmonologist: 1.5 },
        capabilities: ['emergencySurgery'],
        capabilityScores: { emergencySurgery: 20 },
        equipment: ['ventilator'],
        equipmentScores: { ventilator: { present: 25, absent: -40 } },
        bedTypes: ['icu', 'isolationBeds'],
        criticalBeds: ['icu'],
        traumaLevelBonus: false
    },
    infectious: {
        caseAcceptance: 'acceptsInfectious',
        specialists: ['pulmonologist'],
        specialistWeights: { pulmonologist: 1.5 },
        capabilities: [],
        capabilityScores: {},
        equipment: ['ventilator'],
        equipmentScores: { ventilator: { present: 20, absent: -30 } },
        bedTypes: ['isolationBeds', 'icu'],
        criticalBeds: ['isolationBeds'],
        requiresIsolation: true,
        traumaLevelBonus: false
    },
    other: {
        caseAcceptance: 'acceptsTrauma',
        specialists: [],
        specialistWeights: {},
        capabilities: [],
        capabilityScores: {},
        equipment: [],
        equipmentScores: {},
        bedTypes: ['emergency'],
        criticalBeds: [],
        traumaLevelBonus: false
    }
};

// Map legacy types to profiles
const EMERGENCY_TYPE_ALIAS = {
    industrial: 'trauma',
    cardiac: 'cardiac',
    stroke: 'cardiac'
};

// =============================================================================
// CITY PROXIMITY ROUTING GUARD (Production Hardening)
// =============================================================================

const MAX_ROUTING_RADIUS_KM = 150;          // Ignore hospitals beyond 150km
const CROSS_CITY_DISTANCE_PENALTY_KM = 200; // +200km virtual penalty for different city
const CROSS_CITY_SCORE_PENALTY = 0.60;      // Reduce score to 60% for cross-city

// Maximum capability score points that patient history may contribute.
// History is a tiebreaker, not a primary routing driver.
// High confidence (PRIMARY tier): up to 8 pts. Medium (SECONDARY tier): up to 5 pts.
const HISTORY_CAPABILITY_MAX_BONUS = 8;

/**
 * Detect city mismatch between emergency case and hospital.
 * Returns true if the hospital is in a DIFFERENT city than the emergency.
 */
function isCrossCityMismatch(emergencyCase, hospital) {
    const caseCity = (emergencyCase?.city || emergencyCase?.pickupCity || '').toLowerCase().trim();
    const hospCity = (hospital?.basicInfo?.city || hospital?.city || '').toLowerCase().trim();

    // If either city is unknown, skip penalty (don't penalize missing data)
    if (!caseCity || !hospCity) return false;

    return caseCity !== hospCity;
}

// =============================================================================
// NaN-SAFE UTILITY FUNCTIONS (Production Hardening)
// =============================================================================

const IS_DEV = typeof process !== 'undefined'
    ? process.env?.NODE_ENV === 'development'
    : (typeof window !== 'undefined' && window.location?.hostname === 'localhost');

/**
 * Safely extract a numeric value from potentially nested or undefined data
 * Handles: number, {available, count}, undefined, null, NaN
 */
function safeNum(value, fallback = 0) {
    if (value === null || value === undefined) return fallback;
    if (typeof value === 'number') return isNaN(value) ? fallback : value;
    if (typeof value === 'object') {
        // Handle {available: X, count: Y} or {available: X, total: Y} structures
        const num = value.available ?? value.count ?? value.total ?? fallback;
        return typeof num === 'number' && !isNaN(num) ? num : fallback;
    }
    const parsed = parseFloat(value);
    return isNaN(parsed) ? fallback : parsed;
}

/**
 * Ensure a score is a valid number between bounds
 */
function safeScore(score, min = 0, max = 100) {
    if (typeof score !== 'number' || isNaN(score)) return min;
    return Math.max(min, Math.min(max, score));
}

/**
 * Normalize hospital data with safe defaults for all nested fields
 * Prevents undefined field access from causing NaN
 */
export function normalizeHospital(hospital) {
    if (!hospital) return null;

    const safe = {
        id: hospital.id || 'unknown',
        basicInfo: {
            name: hospital.basicInfo?.name || 'Unknown Hospital',
            hospitalType: hospital.basicInfo?.hospitalType || 'general',
            traumaLevel: hospital.basicInfo?.traumaLevel || 'none',
            address: hospital.basicInfo?.address || '',
            phone: hospital.basicInfo?.phone || '',
            location: {
                latitude: safeNum(hospital.basicInfo?.location?.latitude) ||
                    safeNum(hospital.basicInfo?.location?._latitude) || 0,
                longitude: safeNum(hospital.basicInfo?.location?.longitude) ||
                    safeNum(hospital.basicInfo?.location?._longitude) || 0
            }
        },
        bedAvailability: {
            total: safeNum(hospital.bedAvailability?.total, 0),
            available: safeNum(hospital.bedAvailability?.available, 0),
            icu: {
                total: safeNum(hospital.bedAvailability?.icu?.total, 0),
                available: safeNum(hospital.bedAvailability?.icu?.available, 0)
            },
            emergency: {
                total: safeNum(hospital.bedAvailability?.emergency?.total, 0),
                available: safeNum(hospital.bedAvailability?.emergency?.available, 0)
            },
            traumaBeds: {
                total: safeNum(hospital.bedAvailability?.traumaBeds?.total, 0),
                available: safeNum(hospital.bedAvailability?.traumaBeds?.available, 0)
            },
            isolationBeds: {
                total: safeNum(hospital.bedAvailability?.isolationBeds?.total, 0),
                available: safeNum(hospital.bedAvailability?.isolationBeds?.available, 0)
            },
            pediatricBeds: {
                total: safeNum(hospital.bedAvailability?.pediatricBeds?.total, 0),
                available: safeNum(hospital.bedAvailability?.pediatricBeds?.available, 0)
            }
        },
        specialists: normalizeSpecialists(hospital.specialists),
        equipment: {
            ventilators: {
                total: safeNum(hospital.equipment?.ventilators?.total ?? hospital.equipment?.ventilators, 0),
                available: safeNum(hospital.equipment?.ventilators?.available ?? hospital.equipment?.ventilators, 0)
            },
            defibrillators: safeNum(hospital.equipment?.defibrillators, 0),
            portableXRay: safeNum(hospital.equipment?.portableXRay, 0),
            dialysisMachines: safeNum(hospital.equipment?.dialysisMachines, 0),
            ctScanners: safeNum(hospital.equipment?.ctScanners, 0)
        },
        emergencyReadiness: {
            status: hospital.emergencyReadiness?.status || 'accepting',
            diversionStatus: hospital.emergencyReadiness?.diversionStatus || false,
            ambulanceQueue: safeNum(hospital.emergencyReadiness?.ambulanceQueue, 0)
        },
        caseAcceptance: {
            acceptsTrauma: hospital.caseAcceptance?.acceptsTrauma ?? true,
            acceptsCardiac: hospital.caseAcceptance?.acceptsCardiac ?? true,
            acceptsBurns: hospital.caseAcceptance?.acceptsBurns ?? false,
            acceptsPediatric: hospital.caseAcceptance?.acceptsPediatric ?? true,
            acceptsInfectious: hospital.caseAcceptance?.acceptsInfectious ?? false
        },
        clinicalCapabilities: hospital.clinicalCapabilities || {},
        serviceAvailability: hospital.serviceAvailability || {},
        capacityLastUpdated: hospital.capacityLastUpdated || null,
        // Preserve city for cross-city routing guard
        city: hospital.basicInfo?.city || hospital.city || ''
    };

    // ──────────────────────────────────────────────────────────────────
    // Phase-2: LiveOps override — real-time data wins over static data
    // ──────────────────────────────────────────────────────────────────
    const liveOps = hospital.liveOps;
    if (liveOps) {
        // Bed availability overrides
        if (liveOps.bedAvailability) {
            const lb = liveOps.bedAvailability;
            if (lb.icuAvailable != null) safe.bedAvailability.icu.available = safeNum(lb.icuAvailable, safe.bedAvailability.icu.available);
            if (lb.emergencyAvailable != null) safe.bedAvailability.emergency.available = safeNum(lb.emergencyAvailable, safe.bedAvailability.emergency.available);
            if (lb.traumaAvailable != null) safe.bedAvailability.traumaBeds.available = safeNum(lb.traumaAvailable, safe.bedAvailability.traumaBeds.available);
            if (lb.isolationAvailable != null) safe.bedAvailability.isolationBeds.available = safeNum(lb.isolationAvailable, safe.bedAvailability.isolationBeds.available);
        }
        // Equipment overrides
        if (liveOps.equipmentAvailability) {
            const le = liveOps.equipmentAvailability;
            if (le.ventilatorsAvailable != null) safe.equipment.ventilators.available = safeNum(le.ventilatorsAvailable, safe.equipment.ventilators.available);
        }
        // Emergency readiness overrides
        if (liveOps.emergencyReadiness) {
            const lr = liveOps.emergencyReadiness;
            if (lr.status) safe.emergencyReadiness.status = lr.status;
            if (lr.ambulanceQueue != null) safe.emergencyReadiness.ambulanceQueue = safeNum(lr.ambulanceQueue, 0);
        }
    }

    return safe;
}

/**
 * Normalize specialist counts - handle both {count, available} and simple number formats
 */
function normalizeSpecialists(specialists) {
    if (!specialists || typeof specialists !== 'object') return {};

    const normalized = {};
    const specTypes = [
        'cardiologist', 'neurologist', 'traumaSurgeon', 'radiologist',
        'pulmonologist', 'burnSpecialist', 'orthopedic', 'pediatrician'
    ];

    specTypes.forEach(spec => {
        const val = specialists[spec];
        if (val === undefined || val === null) {
            normalized[spec] = 0;
        } else if (typeof val === 'number') {
            normalized[spec] = isNaN(val) ? 0 : val;
        } else if (typeof val === 'object') {
            // Extract available or count from object structure
            normalized[spec] = safeNum(val.available ?? val.count ?? val.total, 0);
        } else {
            normalized[spec] = 0;
        }
    });

    return normalized;
}

/**
 * Debug logging for score breakdown (development only)
 */
function debugScoring(hospitalName, scores, weights, finalScore) {
    if (!IS_DEV) return;

    console.group(`🏥 Scoring Debug: ${hospitalName}`);
    console.log('Capability:', scores.capability);
    console.log('Specialists:', scores.specialists);
    console.log('Equipment:', scores.equipment);
    console.log('Beds:', scores.beds);
    console.log('Distance:', scores.distance);
    console.log('Load:', scores.load);
    console.log('Weights:', weights);
    console.log('Final Score:', finalScore);
    if (isNaN(finalScore)) {
        console.error('⚠️ NaN DETECTED - Check individual scores above');
    }
    console.groupEnd();
}

// =============================================================================
// CORE UTILITY FUNCTIONS
// =============================================================================

function toRad(deg) {
    return deg * (Math.PI / 180);
}

export function calculateDistanceKm(coord1, coord2) {
    // Guard: Missing coordinates - return max distance penalty instead of Infinity
    if (!coord1 || !coord2) {
        if (IS_DEV) console.warn('⚠️ Distance: Missing coordinates, using max penalty');
        return 999;
    }

    const lat1 = safeNum(coord1.latitude ?? coord1._latitude, 0);
    const lon1 = safeNum(coord1.longitude ?? coord1._longitude, 0);
    const lat2 = safeNum(coord2.latitude ?? coord2._latitude, 0);
    const lon2 = safeNum(coord2.longitude ?? coord2._longitude, 0);

    // Guard: Invalid coordinates (all zeros means invalid)
    if (lat1 === 0 && lon1 === 0 && lat2 === 0 && lon2 === 0) {
        if (IS_DEV) console.warn('⚠️ Distance: All coordinates are zero');
        return 999;
    }

    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;

    const result = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    // Guard: NaN or Infinity result
    if (!isFinite(result) || isNaN(result)) {
        if (IS_DEV) console.warn('⚠️ Distance: Calculation returned NaN/Infinity');
        return 999;
    }

    return result;
}

export function estimateETA(distanceKm) {
    // Guard: Invalid distance
    const safeDist = safeNum(distanceKm, 999);
    if (safeDist >= 999) return 999; // Max ETA for invalid distances
    return Math.round((safeDist / 40) * 60);  // 40 km/h average
}

function calculateDistanceScore(distanceKm) {
    // Guard: Invalid distance returns 0 score
    if (!isFinite(distanceKm) || isNaN(distanceKm) || distanceKm >= 999) return 0;
    if (distanceKm <= 0) return 100;
    if (distanceKm >= 50) return 0;
    return Math.max(0, Math.round(100 - (distanceKm * 2)));
}

// =============================================================================
// GOLDEN HOUR MODIFIER
// =============================================================================

function calculateGoldenHourModifier(emergencyCase, escalationBoost = 0) {
    const incidentTimestamp = emergencyCase.emergencyContext?.incidentTimestamp ||
        emergencyCase.incidentTimestamp;

    if (!incidentTimestamp) return { modifier: 0, inGoldenHour: false };

    let timestamp;
    if (incidentTimestamp._seconds) {
        timestamp = incidentTimestamp._seconds * 1000;
    } else if (incidentTimestamp.toMillis) {
        timestamp = incidentTimestamp.toMillis();
    } else {
        timestamp = new Date(incidentTimestamp).getTime();
    }

    const minutesSinceIncident = (Date.now() - timestamp) / (1000 * 60);

    if (minutesSinceIncident <= 60) {
        // Within golden hour: base 10% + escalation amplification
        return {
            modifier: 0.10 + escalationBoost,
            inGoldenHour: true,
            minutesRemaining: Math.round(60 - minutesSinceIncident),
            escalationAmplified: escalationBoost > 0,
        };
    }

    return { modifier: 0, inGoldenHour: false };
}

// =============================================================================
// PRE-SCORING DISQUALIFICATION FILTERS
// =============================================================================

function checkDisqualification(hospital, emergencyCase, profile) {
    const reasons = [];

    // 1. Case acceptance mismatch
    if (!hospital.caseAcceptance?.[profile.caseAcceptance]) {
        reasons.push(`Does not accept ${emergencyCase.emergencyContext?.emergencyType || 'this'} cases`);
    }

    // 2. Hospital FULL
    if (hospital.emergencyReadiness?.status === 'full') {
        reasons.push('Hospital is FULL');
    }

    // 3. Isolation required but no isolation beds
    if (emergencyCase.infectionRisk?.isolationRequired || profile.requiresIsolation) {
        const isolationBeds = hospital.bedAvailability?.isolationBeds?.available || 0;
        if (isolationBeds === 0) {
            reasons.push('No isolation beds available (required)');
        }
    }

    // 4. Critical case but no ICU beds
    const acuity = emergencyCase.acuityLevel;
    if (acuity >= 4 && profile.criticalBeds?.includes('icu')) {
        const icuBeds = hospital.bedAvailability?.icu?.available || 0;
        if (icuBeds === 0) {
            reasons.push('No ICU beds for critical case');
        }
    }

    // 5. No beds at all
    const totalAvailable = hospital.bedAvailability?.available || 0;
    const emergencyBeds = hospital.bedAvailability?.emergency?.available || 0;
    if (totalAvailable === 0 && emergencyBeds === 0) {
        reasons.push('No beds available');
    }

    return {
        disqualified: reasons.length > 0,
        reasons
    };
}

// =============================================================================
// SCORING FUNCTIONS
// =============================================================================

function calculateCapabilityScore(hospital, emergencyCase, profile) {
    let score = 0;
    const reasons = [];

    // Base case acceptance (already checked in disqualification)
    score += 30;
    reasons.push(`Accepts ${emergencyCase.emergencyContext?.emergencyType || 'emergency'} cases`);

    // Trauma level bonus
    if (profile.traumaLevelBonus && hospital.basicInfo?.traumaLevel) {
        const traumaScores = profile.traumaLevelScores ||
            { level_1: 25, level_2: 15, level_3: 8, none: 0 };
        const tScore = traumaScores[hospital.basicInfo.traumaLevel] || 0;
        score += tScore;
        if (tScore > 0) {
            reasons.push(`${hospital.basicInfo.traumaLevel.replace('_', ' ').toUpperCase()} trauma center`);
        }
    }

    // Clinical capabilities with profile-specific scores
    Object.entries(profile.capabilityScores || {}).forEach(([cap, points]) => {
        if (hospital.clinicalCapabilities?.[cap]) {
            score += points;
            reasons.push(`Has ${formatCapability(cap)}`);
        }
    });

    // 24/7 surgery availability for surgical emergencies
    if (hospital.serviceAvailability?.surgery24x7) {
        score += 10;
        reasons.push('24/7 surgery available');
    }

    // ── Optional: ClinicalRoutingContext from QR history ─────────────────────
    // This block is ONLY entered when emergencyCase.clinicalContext is present
    // AND applicable. When absent (no QR scan), execution jumps to the return
    // below — behaviour is identical to before this block existed.
    //
    // clinicalIntents are high-level strings (e.g. 'advanced_cardiology').
    // They are mapped here to the engine's own capability/specialist vocabulary
    // so that qrRelevanceLayer has zero knowledge of engine internals.
    const clinicalContext = emergencyCase?.clinicalContext;
    if (clinicalContext?.applicable) {
        const INTENT_CAPABILITY_MAP = {
            advanced_cardiology:  { caps: ['strokeCenter', 'emergencySurgery'], specs: ['cardiologist'] },
            advanced_neurology:   { caps: ['strokeCenter', 'ctScanAvailable', 'mriAvailable'], specs: ['neurologist'] },
            advanced_respiratory: { caps: ['ctScanAvailable'], specs: ['pulmonologist'] },
            advanced_renal:       { caps: [], specs: [] },
            advanced_hepatic:     { caps: ['ctScanAvailable'], specs: [] },
        };
        // Bonus magnitude scales with confidence: high = 8 pts, medium = 5 pts.
        const bonusPerIntent = clinicalContext.confidence === 'high'
            ? HISTORY_CAPABILITY_MAX_BONUS
            : Math.round(HISTORY_CAPABILITY_MAX_BONUS * 0.6);
        let historyBonus = 0;
        let historyExplained = false;

        (clinicalContext.clinicalIntents || []).forEach(intent => {
            const mapping = INTENT_CAPABILITY_MAP[intent];
            if (!mapping) return;
            const capMatch  = (mapping.caps  || []).some(c => hospital.clinicalCapabilities?.[c]);
            const specMatch = (mapping.specs || []).some(s => (hospital.specialists?.[s] || 0) > 0);
            if (capMatch || specMatch) {
                historyBonus = Math.min(HISTORY_CAPABILITY_MAX_BONUS, historyBonus + bonusPerIntent);
                if (!historyExplained && clinicalContext.explanation?.length) {
                    reasons.push(clinicalContext.explanation[0]);
                    historyExplained = true;
                }
            }
        });
        score += historyBonus;
    }
    // ── End ClinicalRoutingContext block ──────────────────────────────────────

    return { score: Math.min(100, score), reasons };
}

function calculateSpecialistScore(hospital, profile) {
    const specialists = profile.specialists || [];
    const weights = profile.specialistWeights || {};

    if (specialists.length === 0) return { score: 50, reasons: [], count: 0 };

    let weightedCount = 0;
    let rawCount = 0;
    const reasons = [];

    specialists.forEach(spec => {
        const count = hospital.specialists?.[spec] || 0;
        const weight = weights[spec] || 1.0;
        weightedCount += count * weight;
        rawCount += count;

        if (count > 0) {
            reasons.push(`${count} ${formatSpecialist(spec)}${count > 1 ? 's' : ''}`);
        }
    });

    // Score: 0 = 0, 5+ weighted = 100
    const score = Math.min(100, Math.round((weightedCount / 5) * 100));
    return { score, reasons, count: rawCount };
}

function calculateEquipmentScore(hospital, emergencyCase, profile) {
    const supportRequired = emergencyCase.supportRequired || {};
    const equipmentScores = profile.equipmentScores || {};

    let score = 50;  // Base score
    const reasons = [];

    // Check patient-specific requirements with penalties
    if (supportRequired.ventilator) {
        const available = hospital.equipment?.ventilators?.available || 0;
        if (available > 0) {
            score += 20;
            reasons.push(`Ventilator available (${available})`);
        } else {
            score -= 40;  // Heavy penalty
            reasons.push('⚠️ Ventilator required but unavailable');
        }
    }

    if (supportRequired.defibrillator) {
        const available = hospital.equipment?.defibrillators || 0;
        if (available > 0) {
            score += 25;
            reasons.push('Defibrillator available');
        } else {
            score -= 40;
            reasons.push('⚠️ Defibrillator required but unavailable');
        }
    }

    if (supportRequired.oxygen) {
        score += 5;
        reasons.push('Oxygen support available');
    }

    // Emergency-type equipment bonuses/penalties
    Object.entries(equipmentScores).forEach(([eq, scores]) => {
        let available = false;

        if (eq === 'ventilator') available = (hospital.equipment?.ventilators?.available || 0) > 0;
        else if (eq === 'defibrillator') available = (hospital.equipment?.defibrillators || 0) > 0;
        else if (eq === 'portableXRay') available = (hospital.equipment?.portableXRay || 0) > 0;
        else if (eq === 'dialysis') available = (hospital.equipment?.dialysisMachines || 0) > 0;

        if (available) {
            score += scores.present || 0;
        } else {
            score += scores.absent || 0;
        }
    });

    return { score: Math.max(0, Math.min(100, score)), reasons };
}

function calculateBedScore(hospital, emergencyCase, profile) {
    const bedTypes = profile.bedTypes || ['emergency'];
    let availableBeds = 0;
    const reasons = [];

    // Get bed counts by type
    const bedCounts = {
        icu: hospital.bedAvailability?.icu?.available || 0,
        emergency: hospital.bedAvailability?.emergency?.available || 0,
        traumaBeds: hospital.bedAvailability?.traumaBeds?.available || 0,
        isolationBeds: hospital.bedAvailability?.isolationBeds?.available || 0,
        pediatricBeds: hospital.bedAvailability?.pediatricBeds?.available || 0
    };

    bedTypes.forEach(bedType => {
        const count = bedCounts[bedType] || 0;
        if (count > 0) {
            availableBeds += count;
            reasons.push(`${count} ${formatBedType(bedType)}`);
        }
    });

    // Fallback to general availability
    if (availableBeds === 0) {
        availableBeds = hospital.bedAvailability?.available || 0;
        if (availableBeds > 0) {
            reasons.push(`${availableBeds} general beds`);
        }
    }

    if (availableBeds === 0) {
        return { score: 0, reasons: ['No beds available'], icuCount: bedCounts.icu };
    }

    // Score curve
    let score;
    if (availableBeds >= 10) score = Math.min(100, 80 + (availableBeds - 10) * 2);
    else if (availableBeds >= 5) score = 60 + (availableBeds - 5) * 4;
    else score = 20 + availableBeds * 8;

    return {
        score: Math.round(score),
        reasons,
        icuCount: bedCounts.icu,
        totalAvailable: availableBeds
    };
}

function calculateLoadScore(hospital) {
    let score = 100;
    const reasons = [];

    if (hospital.emergencyReadiness?.diversionStatus ||
        hospital.emergencyReadiness?.status === 'diverting') {
        score -= 50;  // Heavy penalty
        reasons.push('Currently on diversion');
    }

    const queue = hospital.emergencyReadiness?.ambulanceQueue || 0;
    if (queue > 0) {
        score -= Math.min(30, queue * 6);
        reasons.push(`${queue} ambulance${queue > 1 ? 's' : ''} in queue`);
    }

    if (!hospital.serviceAvailability?.emergency24x7) {
        score -= 15;
        reasons.push('Emergency not 24/7');
    }

    return {
        score: Math.max(0, score),
        reasons: reasons.length > 0 ? reasons : ['Low operational load'],
        penalty: 100 - Math.max(0, score)
    };
}

function calculateFreshnessPenalty(hospital) {
    const capacityLastUpdated = hospital.capacityLastUpdated;
    if (!capacityLastUpdated) return { multiplier: 0.8, reason: 'Capacity data not updated' };

    let timestamp;
    if (capacityLastUpdated._seconds) timestamp = capacityLastUpdated._seconds * 1000;
    else if (capacityLastUpdated.toMillis) timestamp = capacityLastUpdated.toMillis();
    else timestamp = new Date(capacityLastUpdated).getTime();

    const hours = (Date.now() - timestamp) / (1000 * 60 * 60);

    if (hours > 48) return { multiplier: 0.70, reason: 'Data very stale (48+ hrs)' };
    if (hours > 24) return { multiplier: 0.85, reason: 'Data stale (24+ hrs)' };
    if (hours > 12) return { multiplier: 0.95, reason: 'Data aging (12+ hrs)' };
    return { multiplier: 1.0, reason: null };
}

function getWeightProfile(acuityLevel, goldenHourModifier = 0) {
    let base;

    // AI Triage acuity scale: 1=Immediate, 2=Critical, 3=Urgent, 4=Delayed, 5=Minor
    // CRITICAL: Low acuity number = MORE severe — use capability-heavy profile
    if (acuityLevel === null || acuityLevel === undefined) {
        base = { ...WEIGHT_PROFILES.moderate };
    } else if (acuityLevel <= 2) {
        // Level 1 (Immediate) or 2 (Critical) — life-threatening
        // Prioritize capability, ICU availability, equipment — distance is secondary
        base = { ...WEIGHT_PROFILES.critical };
    } else if (acuityLevel === 3) {
        // Level 3 (Urgent) — moderate severity
        base = { ...WEIGHT_PROFILES.moderate };
    } else {
        // Level 4 (Delayed) or 5 (Minor) — stable, prioritize proximity
        base = { ...WEIGHT_PROFILES.minor };
    }

    // Apply golden hour modifier to distance weight
    if (goldenHourModifier > 0) {
        if (acuityLevel !== null && acuityLevel <= 2) {
            // For critical acuity: doubled golden hour boost — ETA matters even more
            base.distance += goldenHourModifier * 2;
            base.capability -= goldenHourModifier;
            base.beds -= goldenHourModifier;
        } else {
            base.distance += goldenHourModifier;
            base.capability -= goldenHourModifier / 2;
            base.beds -= goldenHourModifier / 2;
        }
    }

    return base;
}

// =============================================================================
// TIE-BREAKER LOGIC
// =============================================================================

function applyTieBreakers(hospitals) {
    return hospitals.sort((a, b) => {
        // Primary: Suitability score
        if (b.suitabilityScore !== a.suitabilityScore) {
            return b.suitabilityScore - a.suitabilityScore;
        }

        // Tie-breaker 1: Shortest distance
        if (a.distanceKm !== b.distanceKm) {
            return a.distanceKm - b.distanceKm;
        }

        // Tie-breaker 2: Highest ICU availability
        const aICU = a.scoreBreakdown?.icuCount || 0;
        const bICU = b.scoreBreakdown?.icuCount || 0;
        if (bICU !== aICU) {
            return bICU - aICU;
        }

        // Tie-breaker 3: Highest specialist count
        const aSpec = a.scoreBreakdown?.specialistCount || 0;
        const bSpec = b.scoreBreakdown?.specialistCount || 0;
        return bSpec - aSpec;
    });
}

// =============================================================================
// MAIN SCORING ENGINE
// =============================================================================

export function scoreHospital(hospital, emergencyCase) {
    // ==========================================================================
    // STEP 1: Normalize hospital data to prevent undefined field access
    // ==========================================================================
    const safeHospital = normalizeHospital(hospital);

    // Guard: Invalid hospital input
    if (!safeHospital) {
        if (IS_DEV) console.warn('⚠️ scoreHospital: Invalid hospital input');
        return {
            hospitalId: hospital?.id || 'unknown',
            hospitalName: 'Unknown Hospital',
            suitabilityScore: 0,
            distanceKm: 999,
            etaMinutes: 999,
            disqualified: true,
            disqualifyReasons: ['Invalid hospital data'],
            scoreBreakdown: {},
            recommendationReasons: []
        };
    }

    const emergencyType = emergencyCase?.emergencyContext?.emergencyType || 'other';
    const mappedType = EMERGENCY_TYPE_ALIAS[emergencyType] || emergencyType;
    const profile = EMERGENCY_PROFILES[mappedType] || EMERGENCY_PROFILES.other;

    // ==========================================================================
    // STEP 2: Safe distance calculation with guards
    // ==========================================================================
    const pickupLocation = emergencyCase?.pickupLocation;
    const hospitalLocation = safeHospital.basicInfo.location;
    const distanceKm = calculateDistanceKm(pickupLocation, hospitalLocation);
    const etaMinutes = estimateETA(distanceKm);

    // Safe distance for output (prevent Infinity/NaN in response)
    const safeDistanceKm = isFinite(distanceKm) && !isNaN(distanceKm)
        ? Math.round(distanceKm * 10) / 10
        : 999;

    // ==========================================================================
    // STEP 3: Pre-scoring disqualification check
    // ==========================================================================
    const disqualCheck = checkDisqualification(safeHospital, emergencyCase, profile);

    if (disqualCheck.disqualified) {
        return {
            hospitalId: safeHospital.id,
            hospitalName: safeHospital.basicInfo.name,
            suitabilityScore: 0,
            distanceKm: safeDistanceKm,
            etaMinutes: isFinite(etaMinutes) ? etaMinutes : 999,
            disqualified: true,
            disqualifyReasons: disqualCheck.reasons,
            scoreBreakdown: {},
            recommendationReasons: []
        };
    }

    // ======================================================================
    // STEP 3b: City Proximity Guard — penalize cross-city hospitals
    // ======================================================================
    let cityPenaltyApplied = false;
    let effectiveDistanceKm = distanceKm;

    if (isCrossCityMismatch(emergencyCase, safeHospital)) {
        effectiveDistanceKm += CROSS_CITY_DISTANCE_PENALTY_KM;
        cityPenaltyApplied = true;
        if (IS_DEV) {
            console.warn(`🌍 Cross-city penalty: ${safeHospital.basicInfo.name} (+${CROSS_CITY_DISTANCE_PENALTY_KM}km virtual)`);
        }
    }

    // ==========================================================================
    // STEP 4: Calculate all component scores with safe guards
    // ==========================================================================
    const goldenHour = calculateGoldenHourModifier(emergencyCase);
    const weights = getWeightProfile(emergencyCase?.acuityLevel, goldenHour.modifier);

    // Calculate scores using normalized hospital data
    const capabilityResult = calculateCapabilityScore(safeHospital, emergencyCase, profile);
    const specialistResult = calculateSpecialistScore(safeHospital, profile);
    const equipmentResult = calculateEquipmentScore(safeHospital, emergencyCase, profile);
    const bedResult = calculateBedScore(safeHospital, emergencyCase, profile);
    const loadResult = calculateLoadScore(safeHospital);
    const distanceScore = calculateDistanceScore(effectiveDistanceKm);
    const freshnessResult = calculateFreshnessPenalty(safeHospital);

    // ==========================================================================
    // STEP 5: Apply safe score guards to all component scores
    // ==========================================================================
    const safeScores = {
        capability: safeScore(capabilityResult.score),
        specialists: safeScore(specialistResult.score),
        equipment: safeScore(equipmentResult.score),
        beds: safeScore(bedResult.score),
        load: safeScore(loadResult.score),
        distance: safeScore(distanceScore)
    };

    // Safe weight extraction with defaults
    const safeWeights = {
        capability: safeNum(weights.capability, 0.4),
        specialists: safeNum(weights.specialists, 0.1),
        equipment: safeNum(weights.equipment, 0.05),
        beds: safeNum(weights.beds, 0.15),
        load: safeNum(weights.load, 0.05),
        distance: safeNum(weights.distance, 0.25)
    };

    // Safe freshness multiplier
    const safeMultiplier = safeNum(freshnessResult.multiplier, 1.0);

    // ==========================================================================
    // STEP 6: Weighted score calculation with NaN detection
    // ==========================================================================
    let weightedScore =
        (safeScores.capability * safeWeights.capability) +
        (safeScores.specialists * safeWeights.specialists) +
        (safeScores.equipment * safeWeights.equipment) +
        (safeScores.beds * safeWeights.beds) +
        (safeScores.load * safeWeights.load) +
        (safeScores.distance * safeWeights.distance);

    let finalScore = Math.round(weightedScore * safeMultiplier);

    // ==========================================================================
    // STEP 7: NaN AUTO-RECOVERY
    // ==========================================================================
    if (isNaN(finalScore) || !isFinite(finalScore)) {
        if (IS_DEV) {
            console.error(`⚠️ NaN DETECTED for ${safeHospital.basicInfo.name}`);
            console.log('Scores:', safeScores);
            console.log('Weights:', safeWeights);
            console.log('Multiplier:', safeMultiplier);
        }

        // Fallback: Use simple average of non-NaN scores
        const validScores = Object.values(safeScores).filter(s => !isNaN(s) && isFinite(s));
        if (validScores.length > 0) {
            finalScore = Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length);
        } else {
            finalScore = 0; // Ultimate fallback
        }
    }

    // ======================================================================
    // STEP 7b: Apply cross-city score penalty
    // ======================================================================
    if (cityPenaltyApplied) {
        finalScore = Math.round(finalScore * CROSS_CITY_SCORE_PENALTY);
    }

    // ==========================================================================
    // STEP 8: Debug instrumentation (development only)
    // ==========================================================================
    debugScoring(safeHospital.basicInfo.name, safeScores, safeWeights, finalScore);

    // ==========================================================================
    // STEP 9: Build recommendation reasons
    // ==========================================================================
    const recommendationReasons = [
        ...capabilityResult.reasons.slice(0, 2),
        ...specialistResult.reasons.slice(0, 1),
        ...bedResult.reasons.slice(0, 2)
    ].filter(r => r);

    if (safeDistanceKm <= 5 && safeDistanceKm < 999) {
        recommendationReasons.push(`Very close (${safeDistanceKm} km)`);
    } else if (safeDistanceKm <= 15 && safeDistanceKm < 999) {
        recommendationReasons.push(`Nearby (${Math.round(safeDistanceKm)} km)`);
    }

    if (goldenHour.inGoldenHour) {
        recommendationReasons.push(`⏱️ Golden hour: ${goldenHour.minutesRemaining}min remaining`);
    }

    if (freshnessResult.reason) recommendationReasons.push(freshnessResult.reason);

    if (cityPenaltyApplied) {
        recommendationReasons.push('⚠️ Cross-city: distance penalty applied');
    }

    // ==========================================================================
    // STEP 10: Return clean, validated result object
    // ==========================================================================
    return {
        hospitalId: safeHospital.id,
        hospitalName: safeHospital.basicInfo.name,
        hospitalType: safeHospital.basicInfo.hospitalType,
        traumaLevel: safeHospital.basicInfo.traumaLevel,
        address: safeHospital.basicInfo.address,
        phone: safeHospital.basicInfo.phone,
        suitabilityScore: finalScore,
        distanceKm: safeDistanceKm,
        etaMinutes: isFinite(etaMinutes) ? etaMinutes : 999,
        disqualified: false,
        scoreBreakdown: {
            capability: safeScores.capability,
            specialists: safeScores.specialists,
            equipment: safeScores.equipment,
            beds: safeScores.beds,
            loadPenalty: safeNum(loadResult.penalty, 0),
            distanceScore: safeScores.distance,
            freshnessMultiplier: safeMultiplier,
            icuCount: safeNum(bedResult.icuCount, 0),
            specialistCount: safeNum(specialistResult.count, 0)
        },
        weights: safeWeights,
        goldenHour,
        recommendationReasons
    };
}

export function rankHospitals(hospitals, emergencyCase, options = {}) {
    if (!hospitals?.length) return [];

    const scored = hospitals.map(h => scoreHospital(h, emergencyCase));

    // Phase 1: Max routing radius guard — filter hospitals beyond 150km
    // unless override is explicitly active
    const withinRadius = options.overrideActive
        ? scored
        : scored.map(h => {
            if (!h.disqualified && h.distanceKm > MAX_ROUTING_RADIUS_KM) {
                return {
                    ...h,
                    disqualified: true,
                    disqualifyReasons: [`Beyond ${MAX_ROUTING_RADIUS_KM}km routing radius (${h.distanceKm}km)`],
                    suitabilityScore: 0
                };
            }
            return h;
        });

    const qualified = withinRadius.filter(h => !h.disqualified);
    const disqualified = withinRadius.filter(h => h.disqualified);

    // Apply tie-breakers to qualified hospitals
    const ranked = applyTieBreakers(qualified);

    return [...ranked, ...disqualified];
}

export function getTopRecommendations(hospitals, emergencyCase, topN = 3) {
    return rankHospitals(hospitals, emergencyCase)
        .filter(h => !h.disqualified)
        .slice(0, topN);
}

export function getBestMatch(hospitals, emergencyCase) {
    const top = getTopRecommendations(hospitals, emergencyCase, 1);
    return top.length > 0 ? top[0] : null;
}

// =============================================================================
// FORMATTERS
// =============================================================================

function formatCapability(cap) {
    const map = {
        strokeCenter: 'Stroke Center', emergencySurgery: 'Emergency Surgery',
        ctScanAvailable: 'CT Scan', mriAvailable: 'MRI', radiology24x7: '24/7 Radiology'
    };
    return map[cap] || cap;
}

function formatSpecialist(spec) {
    const map = {
        cardiologist: 'cardiologist', neurologist: 'neurologist',
        traumaSurgeon: 'trauma surgeon', radiologist: 'radiologist',
        pulmonologist: 'pulmonologist', burnSpecialist: 'burn specialist'
    };
    return map[spec] || spec;
}

function formatBedType(bedType) {
    const map = {
        icu: 'ICU beds', emergency: 'ER beds', traumaBeds: 'trauma beds',
        isolationBeds: 'isolation beds', pediatricBeds: 'pediatric beds'
    };
    return map[bedType] || bedType;
}

// =============================================================================
// EXPORTS
// =============================================================================

export default {
    scoreHospital,
    rankHospitals,
    getTopRecommendations,
    getBestMatch,
    calculateDistanceKm,
    estimateETA,
    WEIGHT_PROFILES,
    EMERGENCY_PROFILES
};
