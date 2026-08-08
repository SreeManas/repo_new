import React, { useEffect, useState, useCallback } from 'react';
import offlineSync from '../utils/offlineSync.js';
import { getFirestore, addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { getAuth } from 'firebase/auth';
import { useT } from '../hooks/useT.js';
import CameraCapture from './CameraCapture.jsx';
import { Camera, X, Image as ImageIcon, QrCode } from 'lucide-react';
import TriagePanel from './ai/TriagePanel.jsx';
import { buildTriagePayload, runAITriage, logTriageToFirestore } from '../services/triageService.js';
import VoiceIntakePanel from './voice/VoiceIntakePanel.jsx';
import { normalizeAndMapAIData } from '../services/voiceNormalization.js';
import QRScanner from './QRScanner.jsx';
import { parsePatientQR } from '../services/qrParserService.js';

// Translation keys
const TRANSLATIONS = {
    patientIntake: 'Patient Intake Form',
    patientIdentification: 'Patient Identification',
    patientName: 'Patient Name (Optional)',
    age: 'Age',
    gender: 'Gender',
    pregnancyStatus: 'Pregnancy Status',
    primaryVitals: 'Primary Vitals',
    bloodPressure: 'Blood Pressure',
    heartRate: 'Heart Rate (bpm)',
    spo2: 'Oxygen Saturation (SpO2 %)',
    temperature: 'Body Temperature',
    respiratoryRate: 'Respiratory Rate (breaths/min)',
    neurologicalStatus: 'Neurological Status',
    consciousnessLevel: 'Consciousness Level',
    headInjurySuspected: 'Head Injury Suspected',
    seizureActivity: 'Seizure Activity',
    respiratoryCardiac: 'Respiratory & Cardiac',
    breathingStatus: 'Breathing Status',
    chestPainPresent: 'Chest Pain Present',
    cardiacHistoryKnown: 'Known Cardiac History',
    traumaAssessment: 'Trauma Assessment',
    injuryType: 'Injury Type',
    bleedingSeverity: 'Bleeding Severity',
    burnsPercentage: 'Burns Coverage (%)',
    emergencyContext: 'Emergency Context',
    emergencyType: 'Emergency Type',
    incidentTimestamp: 'Incident Time',
    environmentalRisks: 'Environmental Risk Factors',
    preHospitalCare: 'Pre-Hospital Care',
    oxygenAdministered: 'Oxygen Administered',
    cprPerformed: 'CPR Performed',
    ivFluidsStarted: 'IV Fluids Started',
    transportSupport: 'Transport & Support Requirements',
    transportPriority: 'Transport Priority',
    ventilatorRequired: 'Ventilator Support Required',
    oxygenRequired: 'Oxygen Support Required',
    defibrillatorRequired: 'Defibrillator Required',
    spinalImmobilization: 'Spinal Immobilization Required',
    infectionRisk: 'Infection Risk Assessment',
    suspectedInfectious: 'Suspected Infectious Disease',
    isolationRequired: 'Isolation Required',
    paramedicNotes: 'Paramedic Notes',
    notesPlaceholder: 'Clinical observations, patient history, medications, allergies...',
    submitCase: 'Dispatch Emergency Ambulance',
    fetchingLocation: 'Fetching location...',
    locationDetected: 'Location detected! Dispatching...',
    caseSubmitted: 'Emergency Incident dispatched successfully!',
    offlineQueued: 'Offline: incident queued, will sync automatically when online.',
};

export default function PatientVitalsForm() {
    // Section 1: Patient Identification
    const [patientName, setPatientName] = useState('');
    const [age, setAge] = useState('');
    const [gender, setGender] = useState('male');
    const [pregnancyStatus, setPregnancyStatus] = useState('unknown');

    // Section 2: Primary Vitals
    const [bloodPressure, setBloodPressure] = useState('');
    const [heartRate, setHeartRate] = useState('');
    const [spo2, setSpo2] = useState('');
    const [temperature, setTemperature] = useState('');
    const [temperatureUnit, setTemperatureUnit] = useState('celsius');
    const [respiratoryRate, setRespiratoryRate] = useState('');

    // Section 3: Neurological Status
    const [consciousnessLevel, setConsciousnessLevel] = useState('alert');
    const [headInjurySuspected, setHeadInjurySuspected] = useState(false);
    const [seizureActivity, setSeizureActivity] = useState(false);

    // Section 4: Respiratory & Cardiac
    const [breathingStatus, setBreathingStatus] = useState('normal');
    const [chestPainPresent, setChestPainPresent] = useState(false);
    const [cardiacHistoryKnown, setCardiacHistoryKnown] = useState(false);

    // Section 5: Trauma Assessment
    const [injuryType, setInjuryType] = useState('none');
    const [bleedingSeverity, setBleedingSeverity] = useState('none');
    const [burnsPercentage, setBurnsPercentage] = useState(0);

    // Section 6: Emergency Context
    const [emergencyType, setEmergencyType] = useState('medical');
    const [incidentTimestamp, setIncidentTimestamp] = useState('');
    const [environmentalRisks, setEnvironmentalRisks] = useState('');

    // Section 7: Pre-Hospital Care
    const [oxygenAdministered, setOxygenAdministered] = useState(false);
    const [cprPerformed, setCprPerformed] = useState(false);
    const [ivFluidsStarted, setIvFluidsStarted] = useState(false);

    // Section 8: Transport & Support Requirements
    const [transportPriority, setTransportPriority] = useState('urgent');
    const [ventilatorRequired, setVentilatorRequired] = useState(false);
    const [oxygenRequired, setOxygenRequired] = useState(false);
    const [defibrillatorRequired, setDefibrillatorRequired] = useState(false);
    const [spinalImmobilization, setSpinalImmobilization] = useState(false);

    // Section 9: Infection Risk
    const [suspectedInfectious, setSuspectedInfectious] = useState(false);
    const [isolationRequired, setIsolationRequired] = useState(false);

    // Section 10: Paramedic Notes
    const [paramedicNotes, setParamedicNotes] = useState('');

    // Section 11: Insurance Information
    const [hasInsurance, setHasInsurance] = useState(null);   // null=not answered, true=yes, false=no
    const [insuranceProvider, setInsuranceProvider] = useState('');
    const [insuranceProviderOther, setInsuranceProviderOther] = useState('');
    const [insuranceCoverageRange, setInsuranceCoverageRange] = useState('');
    const [insurancePolicyCoverage, setInsurancePolicyCoverage] = useState('');

    // Form state
    const [coords, setCoords] = useState({ latitude: null, longitude: null });
    const [status, setStatus] = useState('');
    const [loading, setLoading] = useState(false);
    const [validationErrors, setValidationErrors] = useState({});

    // Sprint-2: Incident Photo Capture State
    const [showCamera, setShowCamera] = useState(false);
    const [capturedPhotos, setCapturedPhotos] = useState([]); // Array of { blob, preview, file }
    const [uploadingPhotos, setUploadingPhotos] = useState(false);

    // AI Triage Engine State
    const [triageResult, setTriageResult] = useState(null);
    const [triageLoading, setTriageLoading] = useState(false);
    const [triageError, setTriageError] = useState(null);

    // Dispatch summary — shown after successful submission
    const [dispatchSummary, setDispatchSummary] = useState(null);

    // QR Scanner State
    const [showQRScanner, setShowQRScanner] = useState(false);
    const [qrError, setQrError] = useState(null);

    // Section: Patient History (from QR)
    const [patientHistory, setPatientHistory] = useState(null);

    // Section: Past Medical History (manually entered)
    const [knownConditions, setKnownConditions] = useState('');
    const [knownAllergies, setKnownAllergies] = useState('');
    const [currentMedications, setCurrentMedications] = useState('');

    // Demo Mode: generate mock crew if real crew is not assigned
    function generateMockCrew() {
        const drivers = ['Ravi Kumar', 'Arjun Singh', 'Suresh Nair', 'Vikram Reddy', 'Deepak Sharma'];
        const paramedics = ['Anil Sharma', 'Meena Patel', 'Kavitha Rao', 'Rajesh Iyer', 'Priya Das'];
        const ambIds = ['AMB-12', 'AMB-07', 'AMB-23', 'AMB-15', 'AMB-31'];
        const etaOptions = [3, 4, 5, 6, 7, 8];
        const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
        return {
            driver: pick(drivers),
            paramedic: pick(paramedics),
            ambulanceId: pick(ambIds),
            eta: pick(etaOptions),
        };
    }

    // Voice Intake: track which fields were auto-filled for glow animation
    const [voiceFilledFields, setVoiceFilledFields] = useState(new Set());

    // Apply glow to a field ID for 1.5s
    const glowField = (id) => {
        setVoiceFilledFields(prev => { const s = new Set(prev); s.add(id); return s; });
        setTimeout(() => setVoiceFilledFields(prev => { const s = new Set(prev); s.delete(id); return s; }), 1500);
    };

    const handleQRScanSuccess = useCallback((decodedText) => {
        const result = parsePatientQR(decodedText);
        if (result.valid && result.data) {
            const d = result.data;
            if (d.name != null) { setPatientName(d.name); glowField('v-patientName'); }
            if (d.age != null) { setAge(d.age); glowField('v-age'); }
            if (d.gender != null) { setGender(d.gender); glowField('v-gender'); }

            let notesAppend = [];
            if (d.overallRisk != null) notesAppend.push(`QR Overall Risk: ${d.overallRisk}`);
            if (d.heartRisk != null) notesAppend.push(`QR Heart Risk: ${d.heartRisk}`);
            if (d.lungsRisk != null) notesAppend.push(`QR Lungs Risk: ${d.lungsRisk}`);
            if (d.brainRisk != null) notesAppend.push(`QR Brain Risk: ${d.brainRisk}`);
            if (d.liverRisk != null) notesAppend.push(`QR Liver Risk: ${d.liverRisk}`);
            if (d.kidneyRisk != null) notesAppend.push(`QR Kidney Risk: ${d.kidneyRisk}`);
            if (d.medications && d.medications.length) notesAppend.push(`QR Meds: ${d.medications.join(', ')}`);

            if (notesAppend.length > 0) {
                setParamedicNotes(prev => {
                    const addition = notesAppend.join('\n');
                    if (!prev || !prev.trim()) return addition;
                    return `${prev}\n---\n${addition}`;
                });
                glowField('v-notes');
            }

            setPatientHistory({
                overallRisk: d.overallRisk,
                heartRisk: d.heartRisk,
                lungsRisk: d.lungsRisk,
                brainRisk: d.brainRisk,
                liverRisk: d.liverRisk,
                kidneyRisk: d.kidneyRisk,
                medications: d.medications
            });

            setShowQRScanner(false);
            setQrError(null);
        } else {
            setQrError(result.error || "Invalid Patient QR");
        }
    }, []);

    // ── Centralized Voice-to-Form Apply ──────────────────────────────────────
    // All AI values go through normalizeAndMapAIData() for enum matching,
    // boolean coercion, numeric clamping, and keyword detection.
    const applyVoiceData = useCallback((rawData) => {
        if (!rawData) return;

        const mapped = normalizeAndMapAIData(rawData);
        if (Object.keys(mapped).length === 0) return;

        // Setter map — every form field that AI can populate
        const setters = {
            patientName: [setPatientName, 'v-patientName'],
            age: [setAge, 'v-age'],
            gender: [setGender, 'v-gender'],
            pregnancyStatus: [setPregnancyStatus, 'v-pregnancy'],
            bloodPressure: [setBloodPressure, 'v-bp'],
            heartRate: [setHeartRate, 'v-hr'],
            spo2: [setSpo2, 'v-spo2'],
            respiratoryRate: [setRespiratoryRate, 'v-rr'],
            temperature: [setTemperature, 'v-temp'],
            consciousnessLevel: [setConsciousnessLevel, 'v-gcs'],
            headInjurySuspected: [setHeadInjurySuspected, 'v-headinjury'],
            seizureActivity: [setSeizureActivity, 'v-seizure'],
            breathingStatus: [setBreathingStatus, 'v-breathing'],
            chestPainPresent: [setChestPainPresent, 'v-chestpain'],
            cardiacHistoryKnown: [setCardiacHistoryKnown, 'v-cardiac'],
            injuryType: [setInjuryType, 'v-injury'],
            bleedingSeverity: [setBleedingSeverity, 'v-bleeding'],
            burnsPercentage: [setBurnsPercentage, 'v-burns'],
            emergencyType: [setEmergencyType, 'v-emergency'],
            transportPriority: [setTransportPriority, 'v-transport'],
            oxygenAdministered: [setOxygenAdministered, 'v-o2admin'],
            cprPerformed: [setCprPerformed, 'v-cpr'],
            ivFluidsStarted: [setIvFluidsStarted, 'v-iv'],
            ventilatorRequired: [setVentilatorRequired, 'v-vent'],
            oxygenRequired: [setOxygenRequired, 'v-o2req'],
            defibrillatorRequired: [setDefibrillatorRequired, 'v-defib'],
            spinalImmobilization: [setSpinalImmobilization, 'v-spinal'],
            suspectedInfectious: [setSuspectedInfectious, 'v-infect'],
            isolationRequired: [setIsolationRequired, 'v-iso'],
            environmentalRisks: [setEnvironmentalRisks, 'v-location'],
        };

        for (const [key, value] of Object.entries(mapped)) {
            const entry = setters[key];
            if (!entry) continue;
            const [setter, glowId] = entry;
            setter(value);
            glowField(glowId);
        }

        // Paramedic notes — append, do NOT overwrite existing content
        if (mapped.paramedicNotes) {
            setParamedicNotes(prev => {
                if (!prev || !prev.trim()) return mapped.paramedicNotes;
                // Avoid duplicating if AI returned same text
                if (prev.includes(mapped.paramedicNotes)) return prev;
                return `${prev}\n---\n${mapped.paramedicNotes}`;
            });
            glowField('v-notes');
        }
    }, []);

    // Translation hooks
    const tPatientIntake = useT(TRANSLATIONS.patientIntake);
    const tSubmitCase = useT(TRANSLATIONS.submitCase);
    const tFetchingLocation = useT(TRANSLATIONS.fetchingLocation);
    const tLocationDetected = useT(TRANSLATIONS.locationDetected);
    const tCaseSubmitted = useT(TRANSLATIONS.caseSubmitted);
    const tOfflineQueued = useT(TRANSLATIONS.offlineQueued);

    const getCurrentLocation = () => {
        return new Promise((resolve, reject) => {
            if (!('geolocation' in navigator)) {
                reject(new Error('Geolocation is not supported by this browser.'));
                return;
            }

            navigator.geolocation.getCurrentPosition(
                (position) => {
                    resolve({
                        latitude: position.coords.latitude,
                        longitude: position.coords.longitude
                    });
                },
                (error) => {
                    reject(error);
                },
                {
                    enableHighAccuracy: true,
                    timeout: 15000,
                    maximumAge: 300000
                }
            );
        });
    };

    // Sprint-2: Photo capture handlers
    const handlePhotoCaptured = (photoData) => {
        // photoData can be a File, Blob, or object with file property
        const file = photoData?.file || photoData;
        if (file && (file instanceof Blob || file instanceof File)) {
            const preview = URL.createObjectURL(file);
            setCapturedPhotos(prev => [...prev, {
                file,
                preview,
                timestamp: Date.now()
            }]);
        }
        setShowCamera(false);
    };

    const removePhoto = (index) => {
        setCapturedPhotos(prev => {
            const newPhotos = [...prev];
            // Revoke the object URL to prevent memory leaks
            if (newPhotos[index]?.preview) {
                URL.revokeObjectURL(newPhotos[index].preview);
            }
            newPhotos.splice(index, 1);
            return newPhotos;
        });
    };

    // MF4: File validation constants
    const MAX_PHOTO_SIZE_MB = 10;
    const ALLOWED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

    const validatePhoto = (photo) => {
        if (!photo?.file) return { valid: false, error: 'No file data' };
        const sizeMB = (photo.file.size || photo.file.byteLength || 0) / (1024 * 1024);
        if (sizeMB > MAX_PHOTO_SIZE_MB) {
            return { valid: false, error: `File too large (${sizeMB.toFixed(1)}MB, max ${MAX_PHOTO_SIZE_MB}MB)` };
        }
        // Blob from camera may not have type — allow it
        if (photo.file.type && !ALLOWED_PHOTO_TYPES.includes(photo.file.type)) {
            return { valid: false, error: `Unsupported type: ${photo.file.type}` };
        }
        return { valid: true };
    };

    const uploadPhotosToStorage = async (caseId) => {
        if (capturedPhotos.length === 0) return [];

        setUploadingPhotos(true);
        const storage = getStorage();
        const uploadedUrls = [];

        try {
            for (const photo of capturedPhotos) {
                // MF4: Validate before upload
                const validation = validatePhoto(photo);
                if (!validation.valid) {
                    console.warn('Skipping invalid photo:', validation.error);
                    continue;
                }

                const fileName = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}.jpg`;
                const storagePath = `incidentPhotos/${caseId}/${fileName}`;
                const storageRef = ref(storage, storagePath);

                await uploadBytes(storageRef, photo.file);
                const downloadUrl = await getDownloadURL(storageRef);
                uploadedUrls.push(downloadUrl);
            }
        } catch (error) {
            console.error('Photo upload error:', error);
            // MF4: Storage failure should NOT block case submission
            // Photos that uploaded successfully are still included
        } finally {
            setUploadingPhotos(false);
        }

        return uploadedUrls;
    };

    const validateForm = () => {
        const errors = {};

        // Required fields
        if (!age || isNaN(age) || age < 0 || age > 120) {
            errors.age = 'Age must be between 0 and 120';
        }

        if (!heartRate || isNaN(heartRate) || heartRate < 0 || heartRate > 300) {
            errors.heartRate = 'Heart rate must be between 0 and 300 bpm';
        }

        if (!spo2 || isNaN(spo2) || spo2 < 0 || spo2 > 100) {
            errors.spo2 = 'SpO2 must be between 0 and 100%';
        }

        // Optional field validations
        if (respiratoryRate && (isNaN(respiratoryRate) || respiratoryRate < 0 || respiratoryRate > 60)) {
            errors.respiratoryRate = 'Respiratory rate must be between 0 and 60';
        }

        if (temperature) {
            if (temperatureUnit === 'celsius' && (temperature < -10 || temperature > 50)) {
                errors.temperature = 'Temperature must be between -10°C and 50°C';
            } else if (temperatureUnit === 'fahrenheit' && (temperature < 14 || temperature > 122)) {
                errors.temperature = 'Temperature must be between 14°F and 122°F';
            }
        }

        if (bloodPressure && !/^\d{2,3}\/\d{2,3}$/.test(bloodPressure)) {
            errors.bloodPressure = 'Blood pressure must be in format: 120/80';
        }

        // Insurance validation — provider and coverage are required when Yes is selected
        if (hasInsurance === true) {
            const effectiveProvider = insuranceProvider === 'Other' ? insuranceProviderOther : insuranceProvider;
            if (!effectiveProvider || !effectiveProvider.trim()) {
                errors.insuranceProvider = 'Insurance provider is required';
            }
            if (!insurancePolicyCoverage) {
                errors.insurancePolicyCoverage = 'Policy coverage amount is required';
            }
        }

        setValidationErrors(errors);
        return Object.keys(errors).length === 0;
    };

    const submitOnline = async (locationCoords) => {
        const db = getFirestore();
        const auth = getAuth();
        const user = auth.currentUser;

        if (!user) {
            throw new Error('You must be logged in to submit a patient case.');
        }

        // Parse incident timestamp or use current time
        const incidentTime = incidentTimestamp
            ? new Date(incidentTimestamp)
            : new Date();

        const caseData = {
            // Patient Information
            patientInfo: {
                name: patientName || null,
                age: parseInt(age),
                gender,
                pregnancyStatus
            },

            // Primary Vitals
            vitals: {
                bloodPressure: bloodPressure || null,
                heartRate: parseInt(heartRate),
                spo2: parseInt(spo2),
                temperature: temperature ? parseFloat(temperature) : null,
                temperatureUnit,
                respiratoryRate: respiratoryRate ? parseInt(respiratoryRate) : null
            },

            // Neurological Assessment
            neurological: {
                consciousnessLevel,
                headInjurySuspected,
                seizureActivity
            },

            // Respiratory & Cardiac
            respiratoryCardiac: {
                breathingStatus,
                chestPainPresent,
                cardiacHistoryKnown
            },

            // Trauma Assessment
            traumaAssessment: {
                injuryType,
                bleedingSeverity,
                burnsPercentage: parseInt(burnsPercentage)
            },

            // Emergency Context
            emergencyContext: {
                emergencyType,
                incidentTimestamp: incidentTime,
                environmentalRisks: environmentalRisks || null
            },

            // Pre-Hospital Care
            preHospitalCare: {
                oxygenAdministered,
                cprPerformed,
                ivFluidsStarted
            },

            // Transport Priority
            transportPriority,

            // Support Requirements
            supportRequired: {
                ventilator: ventilatorRequired,
                oxygen: oxygenRequired,
                defibrillator: defibrillatorRequired,
                spinalImmobilization
            },

            // Infection Risk
            infectionRisk: {
                suspectedInfectious,
                isolationRequired
            },

            // Triage Indicators (AI placeholders)
            triageIndicators: {
                shockSuspected: false,
                respiratoryFailureRisk: false,
                neuroCriticalRisk: false,
                cardiacRisk: false,
                traumaPriority: false
            },

            // Paramedic Notes
            paramedicNotes: paramedicNotes || null,

            // Location & Metadata
            pickupLocation: locationCoords,
            createdAt: serverTimestamp(),
            userId: user.uid,

            // Acuity Level — AI triage result takes precedence; transport priority is fallback
            acuityLevel: (triageResult && !triageResult.error && triageResult.acuity_level)
                ? triageResult.acuity_level
                : transportPriority === 'immediate' ? 5
                    : transportPriority === 'urgent' ? 3
                        : transportPriority === 'delayed' ? 2
                            : 1, // minor

            // AI Triage metadata (stored for routing engine and audit use)
            aiTriage: (triageResult && !triageResult.error) ? {
                acuityLevel: triageResult.acuity_level,
                severityLabel: triageResult.severity_label,
                confidence: triageResult.confidence,
                clinicalFlags: triageResult.clinical_flags,
                reasoningSummary: triageResult.reasoning_summary,
                source: triageResult.source,
                ranAt: new Date().toISOString(),
            } : null,

            // Case Status
            caseStatus: 'intake_completed',

            // Patient History (from QR)
            patientHistory: patientHistory || null,

            // Past Medical History (manually entered)
            pastMedicalHistory: {
                knownConditions: knownConditions.trim() || null,
                knownAllergies: knownAllergies.trim() || null,
                currentMedications: currentMedications.trim() || null,
            },

            // Insurance Information
            insurance: {
                hasInsurance: hasInsurance === true,
                provider: hasInsurance === true
                    ? (insuranceProvider === 'Other' ? (insuranceProviderOther || null) : (insuranceProvider || null))
                    : null,
                policyCoverage: hasInsurance === true ? (insurancePolicyCoverage || null) : null
            },

            // MF4: Incident Photos — uploaded atomically before case write
            incidentPhotos: []
        };

        // MF4: Upload photos FIRST, then write case with URLs included
        if (capturedPhotos.length > 0) {
            const tempId = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const photoUrls = await uploadPhotosToStorage(tempId);
            if (photoUrls.length > 0) {
                caseData.incidentPhotos = photoUrls;
            }
        }

        // Single atomic Firestore write with photo URLs already attached
        const docRef = await addDoc(collection(db, 'emergencyCases'), caseData);
        return docRef.id;
    };

    async function onSubmit(e) {
        e.preventDefault();

        if (!validateForm()) {
            setStatus('Please fix validation errors before submitting');
            return;
        }

        setLoading(true);
        setStatus(tFetchingLocation);
        setDispatchSummary(null);

        try {
            const locationCoords = await getCurrentLocation();
            setCoords(locationCoords);
            setStatus(tLocationDetected);

            if (navigator.onLine) {
                try {
                    const caseId = await submitOnline(locationCoords);
                    // Build dispatch summary for demo display
                    const crew = generateMockCrew();
                    const caseIdLabel = `MED-${Math.floor(1000 + Math.random() * 9000)}`;
                    setDispatchSummary({
                        caseId: caseIdLabel,
                        firestoreId: caseId || null,
                        ambulanceType: (triageResult && !triageResult.error && triageResult.ambulanceType)
                            ? triageResult.ambulanceType : 'Basic Ambulance',
                        acuityLabel: (triageResult && !triageResult.error)
                            ? `Level ${triageResult.acuity_level} — ${triageResult.severity_label}` : 'Pending Triage',
                        driver: crew.driver,
                        paramedic: crew.paramedic,
                        ambulanceId: crew.ambulanceId,
                        eta: crew.eta,
                        timestamp: new Date().toLocaleTimeString(),
                    });
                    setStatus(tCaseSubmitted);
                } catch (submitError) {
                    // MF9: Only queue on Firestore write failure, not Storage failure
                    if (submitError.code === 'unavailable' || submitError.code === 'permission-denied' ||
                        submitError.message?.includes('offline') || !navigator.onLine) {
                        console.warn('Firestore unavailable, queuing for later sync');
                        await offlineSync.enqueueReport({
                            type: 'emergencyCase',
                            data: { age, gender, heartRate, spo2, emergencyType, patientHistory: patientHistory || null },
                            coords: locationCoords
                        });
                        setStatus(tOfflineQueued);
                    } else {
                        throw submitError; // Re-throw non-connectivity errors
                    }
                }
            } else {
                await offlineSync.enqueueReport({
                    type: 'emergencyCase',
                    data: { age, gender, heartRate, spo2, emergencyType, patientHistory: patientHistory || null },
                    coords: locationCoords
                });
                setStatus(tOfflineQueued);
            }

            // Reset form
            resetForm();
        } catch (error) {
            console.error('Submission failed:', error);
            setStatus(`Error: ${error.message}`);
        } finally {
            setLoading(false);
        }
    }

    const resetForm = () => {
        setPatientName('');
        setAge('');
        setGender('male');
        setPregnancyStatus('unknown');
        setBloodPressure('');
        setHeartRate('');
        setSpo2('');
        setTemperature('');
        setRespiratoryRate('');
        setConsciousnessLevel('alert');
        setHeadInjurySuspected(false);
        setSeizureActivity(false);
        setBreathingStatus('normal');
        setChestPainPresent(false);
        setCardiacHistoryKnown(false);
        setInjuryType('none');
        setBleedingSeverity('none');
        setBurnsPercentage(0);
        setEmergencyType('medical');
        setIncidentTimestamp('');
        setEnvironmentalRisks('');
        setOxygenAdministered(false);
        setCprPerformed(false);
        setIvFluidsStarted(false);
        setTransportPriority('urgent');
        setVentilatorRequired(false);
        setOxygenRequired(false);
        setDefibrillatorRequired(false);
        setSpinalImmobilization(false);
        setSuspectedInfectious(false);
        setIsolationRequired(false);
        setParamedicNotes('');
        setHasInsurance(null);
        setInsuranceProvider('');
        setInsuranceProviderOther('');
        setInsuranceCoverageRange('');
        setInsurancePolicyCoverage('');
        setValidationErrors({});
        setTriageResult(null);
        setTriageError(null);
        setTriageLoading(false);
        setKnownConditions('');
        setKnownAllergies('');
        setCurrentMedications('');
        setPatientHistory(null);
    };

    // ── AI Triage handler ──────────────────────────────────────────────────
    const handleRunTriage = useCallback(async () => {
        setTriageLoading(true);
        setTriageError(null);
        try {
            const payload = buildTriagePayload({
                heartRate, spo2, respiratoryRate, bloodPressure,
                temperature, temperatureUnit, consciousnessLevel,
                breathingStatus, bleedingSeverity, injuryType,
                burnsPercentage, cprPerformed, chestPainPresent,
                headInjurySuspected, seizureActivity, emergencyType,
                gender, age
            });
            const result = await runAITriage(payload);
            setTriageResult(result);
            // Log to Firestore (non-blocking)
            logTriageToFirestore({ triageResult: result, vitalsPayload: payload, caseId: null });
        } catch (err) {
            setTriageError(`AI Triage failed: ${err.message}. Using transport priority as fallback.`);
        } finally {
            setTriageLoading(false);
        }
    }, [
        heartRate, spo2, respiratoryRate, bloodPressure,
        temperature, temperatureUnit, consciousnessLevel,
        breathingStatus, bleedingSeverity, injuryType,
        burnsPercentage, cprPerformed, chestPainPresent,
        headInjurySuspected, seizureActivity, emergencyType,
        gender, age
    ]);

    return (
        <div className="card p-6 shadow-lg max-w-4xl mx-auto">
            <div className="mb-6">
                <h2 className="text-2xl font-bold text-gray-900 mb-2">{tPatientIntake}</h2>
                <p className="text-sm text-gray-600">
                    Complete emergency incident assessment for AI triage classification and ambulance dispatch.
                </p>
            </div>

            <form onSubmit={onSubmit} className="space-y-8">
                {/* Top Actions: Voice & QR */}
                <div className="flex flex-col sm:flex-row gap-4">
                    <div className="flex-1">
                        <VoiceIntakePanel onApplyData={applyVoiceData} />
                    </div>
                    <div className="flex-none flex items-center">
                        <button
                            type="button"
                            onClick={() => setShowQRScanner(true)}
                            className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 rounded-xl transition-colors font-medium shadow-sm h-full min-h-[56px]"
                        >
                            <QrCode className="w-5 h-5" />
                            Scan Patient QR
                        </button>
                    </div>
                </div>

                {/* Section 1: Patient Identification */}
                <section className="border border-gray-200 rounded-lg p-5 bg-gradient-to-r from-blue-50 to-indigo-50">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                        </svg>
                        {useT(TRANSLATIONS.patientIdentification)}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                {useT(TRANSLATIONS.patientName)}
                            </label>
                            <input
                                type="text"
                                className="input"
                                value={patientName}
                                onChange={(e) => setPatientName(e.target.value)}
                                placeholder="John Doe"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                {useT(TRANSLATIONS.age)} <span className="text-red-500">*</span>
                            </label>
                            <input
                                type="number"
                                className={`input ${validationErrors.age ? 'border-red-500' : ''}`}
                                value={age}
                                onChange={(e) => setAge(e.target.value)}
                                placeholder="45"
                                required
                            />
                            {validationErrors.age && (
                                <p className="text-xs text-red-500 mt-1">{validationErrors.age}</p>
                            )}
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                {useT(TRANSLATIONS.gender)} <span className="text-red-500">*</span>
                            </label>
                            <select className="input" value={gender} onChange={(e) => setGender(e.target.value)}>
                                <option value="male">Male</option>
                                <option value="female">Female</option>
                                <option value="other">Other</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                {useT(TRANSLATIONS.pregnancyStatus)}
                            </label>
                            <select className="input" value={pregnancyStatus} onChange={(e) => setPregnancyStatus(e.target.value)}>
                                <option value="unknown">Unknown</option>
                                <option value="pregnant">Pregnant</option>
                                <option value="not_pregnant">Not Pregnant</option>
                            </select>
                        </div>
                    </div>
                </section>

                {/* Section 1.5: Past Medical History */}
                <section className="border border-gray-200 rounded-lg p-5 bg-gradient-to-r from-purple-50 to-indigo-50">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                        Past Medical History
                        {patientHistory && (
                            <span className="ml-2 text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full font-medium">QR Data Loaded</span>
                        )}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Known Medical Conditions</label>
                            <textarea
                                className="input min-h-[80px] resize-y"
                                value={knownConditions}
                                onChange={(e) => setKnownConditions(e.target.value)}
                                placeholder="e.g. Hypertension, Diabetes Type 2, Asthma..."
                                rows={3}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Known Allergies</label>
                            <textarea
                                className="input min-h-[80px] resize-y"
                                value={knownAllergies}
                                onChange={(e) => setKnownAllergies(e.target.value)}
                                placeholder="e.g. Penicillin, Aspirin, Latex..."
                                rows={3}
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">Current Medications</label>
                            <textarea
                                className="input min-h-[80px] resize-y"
                                value={currentMedications}
                                onChange={(e) => setCurrentMedications(e.target.value)}
                                placeholder="e.g. Metformin 500mg, Amlodipine 5mg..."
                                rows={3}
                            />
                        </div>
                    </div>

                    {/* QR Organ Risk Panel — shown only when QR is scanned */}
                    {patientHistory && (
                        <div className="mt-4 pt-4 border-t border-purple-200">
                            <p className="text-xs font-semibold text-purple-600 uppercase tracking-wide mb-3">Organ Risk Scores (from Patient QR Card)</p>
                            <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
                                {[
                                    { label: 'Overall', value: patientHistory.overallRisk },
                                    { label: 'Heart', value: patientHistory.heartRisk },
                                    { label: 'Lungs', value: patientHistory.lungsRisk },
                                    { label: 'Brain', value: patientHistory.brainRisk },
                                    { label: 'Liver', value: patientHistory.liverRisk },
                                    { label: 'Kidney', value: patientHistory.kidneyRisk },
                                ].map(({ label, value }) => (
                                    <div key={label} className="text-center">
                                        <div className="text-xs text-gray-500 mb-1">{label}</div>
                                        <div className={`text-sm font-bold px-2 py-1 rounded-md ${
                                            value >= 70 ? 'bg-red-100 text-red-700' :
                                            value >= 40 ? 'bg-yellow-100 text-yellow-700' :
                                            'bg-green-100 text-green-700'
                                        }`}>{value ?? 'N/A'}</div>
                                    </div>
                                ))}
                            </div>
                            {patientHistory.medications?.length > 0 && (
                                <div className="mt-3">
                                    <p className="text-xs text-gray-500 mb-1 font-medium">QR Medications on Record</p>
                                    <p className="text-sm text-gray-800 bg-white border border-purple-200 rounded-md px-3 py-2">
                                        {patientHistory.medications.join(', ')}
                                    </p>
                                </div>
                            )}
                        </div>
                    )}
                </section>

                {/* Section 2: Primary Vitals */}
                <section className="border border-gray-200 rounded-lg p-5 bg-gradient-to-r from-red-50 to-pink-50">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                        </svg>
                        {useT(TRANSLATIONS.primaryVitals)}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                {useT(TRANSLATIONS.bloodPressure)}
                            </label>
                            <input
                                type="text"
                                className={`input ${validationErrors.bloodPressure ? 'border-red-500' : ''}`}
                                value={bloodPressure}
                                onChange={(e) => setBloodPressure(e.target.value)}
                                placeholder="120/80"
                            />
                            {validationErrors.bloodPressure && (
                                <p className="text-xs text-red-500 mt-1">{validationErrors.bloodPressure}</p>
                            )}
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                {useT(TRANSLATIONS.heartRate)} <span className="text-red-500">*</span>
                            </label>
                            <input
                                type="number"
                                className={`input ${validationErrors.heartRate ? 'border-red-500' : ''}`}
                                value={heartRate}
                                onChange={(e) => setHeartRate(e.target.value)}
                                placeholder="72"
                                required
                            />
                            {validationErrors.heartRate && (
                                <p className="text-xs text-red-500 mt-1">{validationErrors.heartRate}</p>
                            )}
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                {useT(TRANSLATIONS.spo2)} <span className="text-red-500">*</span>
                            </label>
                            <input
                                type="number"
                                className={`input ${validationErrors.spo2 ? 'border-red-500' : ''}`}
                                value={spo2}
                                onChange={(e) => setSpo2(e.target.value)}
                                placeholder="98"
                                required
                            />
                            {validationErrors.spo2 && (
                                <p className="text-xs text-red-500 mt-1">{validationErrors.spo2}</p>
                            )}
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                {useT(TRANSLATIONS.temperature)}
                            </label>
                            <div className="flex gap-2">
                                <input
                                    type="number"
                                    step="0.1"
                                    className={`input flex-1 ${validationErrors.temperature ? 'border-red-500' : ''}`}
                                    value={temperature}
                                    onChange={(e) => setTemperature(e.target.value)}
                                    placeholder="37.0"
                                />
                                <select className="input w-24" value={temperatureUnit} onChange={(e) => setTemperatureUnit(e.target.value)}>
                                    <option value="celsius">°C</option>
                                    <option value="fahrenheit">°F</option>
                                </select>
                            </div>
                            {validationErrors.temperature && (
                                <p className="text-xs text-red-500 mt-1">{validationErrors.temperature}</p>
                            )}
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                {useT(TRANSLATIONS.respiratoryRate)}
                            </label>
                            <input
                                type="number"
                                className={`input ${validationErrors.respiratoryRate ? 'border-red-500' : ''}`}
                                value={respiratoryRate}
                                onChange={(e) => setRespiratoryRate(e.target.value)}
                                placeholder="16"
                            />
                            {validationErrors.respiratoryRate && (
                                <p className="text-xs text-red-500 mt-1">{validationErrors.respiratoryRate}</p>
                            )}
                        </div>
                    </div>
                </section>

                {/* Section 3: Neurological Status */}
                <section className="border border-gray-200 rounded-lg p-5 bg-gradient-to-r from-purple-50 to-pink-50">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                        </svg>
                        {useT(TRANSLATIONS.neurologicalStatus)}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                {useT(TRANSLATIONS.consciousnessLevel)} <span className="text-red-500">*</span>
                            </label>
                            <select className="input" value={consciousnessLevel} onChange={(e) => setConsciousnessLevel(e.target.value)}>
                                <option value="alert">Alert</option>
                                <option value="verbal">Responds to Verbal</option>
                                <option value="pain">Responds to Pain</option>
                                <option value="unresponsive">Unresponsive</option>
                            </select>
                        </div>
                        <div className="space-y-3 pt-2">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={headInjurySuspected}
                                    onChange={(e) => setHeadInjurySuspected(e.target.checked)}
                                    className="w-4 h-4 text-purple-600 rounded"
                                />
                                <span className="text-sm text-gray-700">{useT(TRANSLATIONS.headInjurySuspected)}</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={seizureActivity}
                                    onChange={(e) => setSeizureActivity(e.target.checked)}
                                    className="w-4 h-4 text-purple-600 rounded"
                                />
                                <span className="text-sm text-gray-700">{useT(TRANSLATIONS.seizureActivity)}</span>
                            </label>
                        </div>
                    </div>
                </section>

                {/* Section 4: Respiratory & Cardiac */}
                <section className="border border-gray-200 rounded-lg p-5 bg-gradient-to-r from-cyan-50 to-blue-50">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-cyan-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
                        </svg>
                        {useT(TRANSLATIONS.respiratoryCardiac)}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                {useT(TRANSLATIONS.breathingStatus)}
                            </label>
                            <select className="input" value={breathingStatus} onChange={(e) => setBreathingStatus(e.target.value)}>
                                <option value="normal">Normal</option>
                                <option value="labored">Labored</option>
                                <option value="assisted">Assisted Ventilation</option>
                                <option value="not_breathing">Not Breathing</option>
                            </select>
                        </div>
                        <div className="space-y-3 pt-2">
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={chestPainPresent}
                                    onChange={(e) => setChestPainPresent(e.target.checked)}
                                    className="w-4 h-4 text-cyan-600 rounded"
                                />
                                <span className="text-sm text-gray-700">{useT(TRANSLATIONS.chestPainPresent)}</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    checked={cardiacHistoryKnown}
                                    onChange={(e) => setCardiacHistoryKnown(e.target.checked)}
                                    className="w-4 h-4 text-cyan-600 rounded"
                                />
                                <span className="text-sm text-gray-700">{useT(TRANSLATIONS.cardiacHistoryKnown)}</span>
                            </label>
                        </div>
                    </div>
                </section>

                {/* Section 5: Trauma Assessment */}
                <section className="border border-gray-200 rounded-lg p-5 bg-gradient-to-r from-orange-50 to-red-50">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        {useT(TRANSLATIONS.traumaAssessment)}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                {useT(TRANSLATIONS.injuryType)}
                            </label>
                            <select className="input" value={injuryType} onChange={(e) => setInjuryType(e.target.value)}>
                                <option value="none">None</option>
                                <option value="fracture">Fracture</option>
                                <option value="polytrauma">Polytrauma</option>
                                <option value="burns">Burns</option>
                                <option value="laceration">Laceration</option>
                                <option value="internal">Internal Injury</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                {useT(TRANSLATIONS.bleedingSeverity)}
                            </label>
                            <select className="input" value={bleedingSeverity} onChange={(e) => setBleedingSeverity(e.target.value)}>
                                <option value="none">None</option>
                                <option value="mild">Mild</option>
                                <option value="severe">Severe</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                {useT(TRANSLATIONS.burnsPercentage)}
                            </label>
                            <input
                                type="range"
                                min="0"
                                max="100"
                                className="w-full"
                                value={burnsPercentage}
                                onChange={(e) => setBurnsPercentage(e.target.value)}
                            />
                            <div className="text-center text-sm font-semibold text-orange-600 mt-1">
                                {burnsPercentage}%
                            </div>
                        </div>
                    </div>
                </section>

                {/* Section 6: Emergency Context */}
                <section className="border border-gray-200 rounded-lg p-5 bg-gradient-to-r from-yellow-50 to-orange-50">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        {useT(TRANSLATIONS.emergencyContext)}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                {useT(TRANSLATIONS.emergencyType)} <span className="text-red-500">*</span>
                            </label>
                            <select className="input" value={emergencyType} onChange={(e) => setEmergencyType(e.target.value)}>
                                <option value="medical">Medical</option>
                                <option value="accident">Accident</option>
                                <option value="cardiac">Cardiac</option>
                                <option value="fire">Fire</option>
                                <option value="industrial">Industrial</option>
                                <option value="other">Other</option>
                            </select>
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                {useT(TRANSLATIONS.incidentTimestamp)}
                            </label>
                            <input
                                type="datetime-local"
                                className="input"
                                value={incidentTimestamp}
                                onChange={(e) => setIncidentTimestamp(e.target.value)}
                            />
                        </div>
                        <div className="md:col-span-2">
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                {useT(TRANSLATIONS.environmentalRisks)}
                            </label>
                            <textarea
                                className="input"
                                rows={2}
                                value={environmentalRisks}
                                onChange={(e) => setEnvironmentalRisks(e.target.value)}
                                placeholder="Hazardous materials, unstable structure, traffic..."
                            />
                        </div>
                    </div>
                </section>

                {/* Section 7: Pre-Hospital Care */}
                <section className="border border-gray-200 rounded-lg p-5 bg-gradient-to-r from-green-50 to-emerald-50">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        {useT(TRANSLATIONS.preHospitalCare)}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                        <label className="flex items-center gap-2 cursor-pointer p-3 bg-white rounded-lg border border-green-200">
                            <input
                                type="checkbox"
                                checked={oxygenAdministered}
                                onChange={(e) => setOxygenAdministered(e.target.checked)}
                                className="w-4 h-4 text-green-600 rounded"
                            />
                            <span className="text-sm text-gray-700">{useT(TRANSLATIONS.oxygenAdministered)}</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer p-3 bg-white rounded-lg border border-green-200">
                            <input
                                type="checkbox"
                                checked={cprPerformed}
                                onChange={(e) => setCprPerformed(e.target.checked)}
                                className="w-4 h-4 text-green-600 rounded"
                            />
                            <span className="text-sm text-gray-700">{useT(TRANSLATIONS.cprPerformed)}</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer p-3 bg-white rounded-lg border border-green-200">
                            <input
                                type="checkbox"
                                checked={ivFluidsStarted}
                                onChange={(e) => setIvFluidsStarted(e.target.checked)}
                                className="w-4 h-4 text-green-600 rounded"
                            />
                            <span className="text-sm text-gray-700">{useT(TRANSLATIONS.ivFluidsStarted)}</span>
                        </label>
                    </div>
                </section>

                {/* Section 8: Transport & Support Requirements */}
                <section className="border border-gray-200 rounded-lg p-5 bg-gradient-to-r from-indigo-50 to-purple-50">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                        </svg>
                        {useT(TRANSLATIONS.transportSupport)}
                    </h3>
                    <div className="space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                {useT(TRANSLATIONS.transportPriority)} <span className="text-red-500">*</span>
                            </label>
                            <select className="input" value={transportPriority} onChange={(e) => setTransportPriority(e.target.value)}>
                                <option value="immediate">Immediate (Red)</option>
                                <option value="urgent">Urgent (Yellow)</option>
                                <option value="delayed">Delayed (Green)</option>
                                <option value="minor">Minor (White)</option>
                            </select>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <label className="flex items-center gap-2 cursor-pointer p-3 bg-white rounded-lg border border-indigo-200">
                                <input
                                    type="checkbox"
                                    checked={ventilatorRequired}
                                    onChange={(e) => setVentilatorRequired(e.target.checked)}
                                    className="w-4 h-4 text-indigo-600 rounded"
                                />
                                <span className="text-sm text-gray-700">{useT(TRANSLATIONS.ventilatorRequired)}</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer p-3 bg-white rounded-lg border border-indigo-200">
                                <input
                                    type="checkbox"
                                    checked={oxygenRequired}
                                    onChange={(e) => setOxygenRequired(e.target.checked)}
                                    className="w-4 h-4 text-indigo-600 rounded"
                                />
                                <span className="text-sm text-gray-700">{useT(TRANSLATIONS.oxygenRequired)}</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer p-3 bg-white rounded-lg border border-indigo-200">
                                <input
                                    type="checkbox"
                                    checked={defibrillatorRequired}
                                    onChange={(e) => setDefibrillatorRequired(e.target.checked)}
                                    className="w-4 h-4 text-indigo-600 rounded"
                                />
                                <span className="text-sm text-gray-700">{useT(TRANSLATIONS.defibrillatorRequired)}</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer p-3 bg-white rounded-lg border border-indigo-200">
                                <input
                                    type="checkbox"
                                    checked={spinalImmobilization}
                                    onChange={(e) => setSpinalImmobilization(e.target.checked)}
                                    className="w-4 h-4 text-indigo-600 rounded"
                                />
                                <span className="text-sm text-gray-700">{useT(TRANSLATIONS.spinalImmobilization)}</span>
                            </label>
                        </div>
                    </div>
                </section>

                {/* Section 9: Infection Risk Assessment */}
                <section className="border border-gray-200 rounded-lg p-5 bg-gradient-to-r from-pink-50 to-red-50">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-pink-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                        </svg>
                        {useT(TRANSLATIONS.infectionRisk)}
                    </h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <label className="flex items-center gap-2 cursor-pointer p-3 bg-white rounded-lg border border-pink-200">
                            <input
                                type="checkbox"
                                checked={suspectedInfectious}
                                onChange={(e) => setSuspectedInfectious(e.target.checked)}
                                className="w-4 h-4 text-pink-600 rounded"
                            />
                            <span className="text-sm text-gray-700">{useT(TRANSLATIONS.suspectedInfectious)}</span>
                        </label>
                        <label className="flex items-center gap-2 cursor-pointer p-3 bg-white rounded-lg border border-pink-200">
                            <input
                                type="checkbox"
                                checked={isolationRequired}
                                onChange={(e) => setIsolationRequired(e.target.checked)}
                                className="w-4 h-4 text-pink-600 rounded"
                            />
                            <span className="text-sm text-gray-700">{useT(TRANSLATIONS.isolationRequired)}</span>
                        </label>
                    </div>
                </section>

                {/* Section 10: Paramedic Notes */}
                <section className="border border-gray-200 rounded-lg p-5 bg-gradient-to-r from-gray-50 to-slate-50">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                        {useT(TRANSLATIONS.paramedicNotes)}
                    </h3>
                    <textarea
                        className="input"
                        rows={4}
                        value={paramedicNotes}
                        onChange={(e) => setParamedicNotes(e.target.value)}
                        placeholder={useT(TRANSLATIONS.notesPlaceholder)}
                    />
                </section>

                {/* Sprint-2: Section 11 - Incident Photo Capture */}
                <section className="border border-gray-200 rounded-lg p-5 bg-gradient-to-r from-amber-50 to-yellow-50">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                        <Camera className="w-5 h-5 text-amber-600" />
                        Incident Photo Documentation
                    </h3>

                    {/* Photo Grid */}
                    {capturedPhotos.length > 0 && (
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                            {capturedPhotos.map((photo, index) => (
                                <div key={photo.timestamp} className="relative group">
                                    <img
                                        src={photo.preview}
                                        alt={`Incident photo ${index + 1}`}
                                        className="w-full h-24 object-cover rounded-lg border border-amber-200"
                                    />
                                    <button
                                        type="button"
                                        onClick={() => removePhoto(index)}
                                        className="absolute -top-2 -right-2 w-6 h-6 bg-red-500 text-white rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                                    >
                                        <X className="w-4 h-4" />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}

                    {/* Capture Button */}
                    <button
                        type="button"
                        onClick={() => setShowCamera(true)}
                        className="flex items-center gap-2 px-4 py-3 bg-amber-500 text-white rounded-lg hover:bg-amber-600 transition-colors w-full justify-center"
                    >
                        <Camera className="w-5 h-5" />
                        {capturedPhotos.length === 0 ? 'Capture Incident Photo' : 'Add Another Photo'}
                    </button>

                    {capturedPhotos.length > 0 && (
                        <p className="text-xs text-amber-700 mt-2 text-center">
                            {capturedPhotos.length} photo{capturedPhotos.length > 1 ? 's' : ''} captured
                        </p>
                    )}
                </section>

                {/* GPS Auto-Capture Notice */}
                <div className="p-4 bg-gradient-to-r from-green-50 to-emerald-50 rounded-lg border border-green-200">
                    <div className="flex items-center gap-3">
                        <svg className="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                        </svg>
                        <div>
                            <p className="text-sm font-medium text-green-800">GPS Location Auto-Capture</p>
                            <p className="text-xs text-green-700">Pickup location will be automatically captured when you submit</p>
                        </div>
                    </div>
                </div>

                {/* AI Triage Engine */}
                <TriagePanel
                    triageResult={triageResult}
                    isLoading={triageLoading}
                    onRunTriage={handleRunTriage}
                    error={triageError}
                />

                {/* QR Scanner Modal */}
                {showQRScanner && (
                    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/80 p-4">
                        <div className="bg-gray-900 rounded-xl max-w-sm w-full p-2 relative">
                            {qrError && (
                                <div className="mb-2 bg-red-900/50 text-red-200 p-3 rounded text-sm text-center border border-red-800">
                                    {qrError}
                                </div>
                            )}
                            <QRScanner
                                onScanSuccess={handleQRScanSuccess}
                                onClose={() => { setShowQRScanner(false); setQrError(null); }}
                            />
                        </div>
                    </div>
                )}

                {/* Camera Modal */}
                {showCamera && (
                    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
                        <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-auto">
                            <div className="p-4 border-b flex items-center justify-between">
                                <h4 className="text-lg font-semibold">Capture Incident Photo</h4>
                                <button
                                    type="button"
                                    onClick={() => setShowCamera(false)}
                                    className="p-2 hover:bg-gray-100 rounded-lg"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                            <div className="p-4">
                                <CameraCapture
                                    onPhotoCaptured={handlePhotoCaptured}
                                    onClose={() => setShowCamera(false)}
                                />
                            </div>
                        </div>
                    </div>
                )}

                {/* Section 11: Insurance Information */}
                <section className="border border-gray-200 rounded-lg p-5 bg-gradient-to-r from-emerald-50 to-teal-50">
                    <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
                        <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                        </svg>
                        Insurance Information
                    </h3>

                    {/* Has Insurance — Radio */}
                    <div className="mb-5">
                        <label className="block text-sm font-medium text-gray-700 mb-3">
                            Does the patient have health insurance?
                        </label>
                        <div className="flex gap-6">
                            <label className="flex items-center gap-2 cursor-pointer select-none">
                                <input
                                    type="radio"
                                    name="hasInsurance"
                                    value="yes"
                                    checked={hasInsurance === true}
                                    onChange={() => setHasInsurance(true)}
                                    className="w-4 h-4 text-emerald-600 accent-emerald-600"
                                />
                                <span className="text-sm text-gray-800 font-medium">Yes</span>
                            </label>
                            <label className="flex items-center gap-2 cursor-pointer select-none">
                                <input
                                    type="radio"
                                    name="hasInsurance"
                                    value="no"
                                    checked={hasInsurance === false}
                                    onChange={() => {
                                        setHasInsurance(false);
                                        setInsuranceProvider('');
                                        setInsuranceProviderOther('');
                                        setInsuranceCoverageRange('');
                                        setInsurancePolicyCoverage('');
                                    }}
                                    className="w-4 h-4 text-emerald-600 accent-emerald-600"
                                />
                                <span className="text-sm text-gray-800 font-medium">No</span>
                            </label>
                        </div>
                    </div>

                    {/* Conditional fields — only when Yes */}
                    {hasInsurance === true && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2 border-t border-emerald-100">

                            {/* Field 1: Insurance Provider */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Insurance Provider <span className="text-red-500">*</span>
                                </label>
                                <select
                                    className={`input ${validationErrors.insuranceProvider && insuranceProvider !== 'Other' ? 'border-red-500' : ''}`}
                                    value={insuranceProvider}
                                    onChange={(e) => {
                                        setInsuranceProvider(e.target.value);
                                        if (e.target.value !== 'Other') setInsuranceProviderOther('');
                                    }}
                                >
                                    <option value="">— Select Provider —</option>
                                    <option value="Star Health">Star Health</option>
                                    <option value="Niva Bupa">Niva Bupa</option>
                                    <option value="ICICI Lombard">ICICI Lombard</option>
                                    <option value="HDFC ERGO">HDFC ERGO</option>
                                    <option value="Care Health">Care Health</option>
                                    <option value="Tata AIG">Tata AIG</option>
                                    <option value="Aditya Birla Health">Aditya Birla Health</option>
                                    <option value="SBI General">SBI General</option>
                                    <option value="Reliance General">Reliance General</option>
                                    <option value="Bajaj Allianz">Bajaj Allianz</option>
                                    <option value="New India Assurance">New India Assurance</option>
                                    <option value="Oriental Insurance">Oriental Insurance</option>
                                    <option value="National Insurance">National Insurance</option>
                                    <option value="United India Insurance">United India Insurance</option>
                                    <option value="ACKO">ACKO</option>
                                    <option value="ManipalCigna">ManipalCigna</option>
                                    <option value="Other">Other</option>
                                </select>

                                {/* Manual entry when Other is chosen */}
                                {insuranceProvider === 'Other' && (
                                    <input
                                        type="text"
                                        className={`input mt-2 ${validationErrors.insuranceProvider ? 'border-red-500' : ''}`}
                                        placeholder="Enter provider name"
                                        value={insuranceProviderOther}
                                        onChange={(e) => setInsuranceProviderOther(e.target.value)}
                                        maxLength={80}
                                    />
                                )}
                                {validationErrors.insuranceProvider && (
                                    <p className="text-xs text-red-500 mt-1">{validationErrors.insuranceProvider}</p>
                                )}
                            </div>

                            {/* Field 2: Policy Coverage Amount */}
                            <div>
                                <label className="block text-sm font-medium text-gray-700 mb-2">
                                    Policy Coverage Amount (Sum Insured) <span className="text-red-500">*</span>
                                </label>
                                <select
                                    className={`input ${validationErrors.insurancePolicyCoverage ? 'border-red-500' : ''}`}
                                    value={insurancePolicyCoverage}
                                    onChange={(e) => setInsurancePolicyCoverage(e.target.value)}
                                >
                                    <option value="">— Select Sum Insured —</option>
                                    <option value="₹50,000">₹50,000</option>
                                    <option value="₹1 Lakh">₹1 Lakh</option>
                                    <option value="₹2 Lakhs">₹2 Lakhs</option>
                                    <option value="₹3 Lakhs">₹3 Lakhs</option>
                                    <option value="₹5 Lakhs">₹5 Lakhs</option>
                                    <option value="₹7.5 Lakhs">₹7.5 Lakhs</option>
                                    <option value="₹10 Lakhs">₹10 Lakhs</option>
                                    <option value="₹15 Lakhs">₹15 Lakhs</option>
                                    <option value="₹20 Lakhs">₹20 Lakhs</option>
                                    <option value="₹25 Lakhs">₹25 Lakhs</option>
                                    <option value="₹50 Lakhs">₹50 Lakhs</option>
                                    <option value="₹75 Lakhs">₹75 Lakhs</option>
                                    <option value="₹1 Crore">₹1 Crore</option>
                                    <option value="Above ₹1 Crore">Above ₹1 Crore</option>
                                </select>
                                {validationErrors.insurancePolicyCoverage && (
                                    <p className="text-xs text-red-500 mt-1">{validationErrors.insurancePolicyCoverage}</p>
                                )}
                                {insurancePolicyCoverage && !validationErrors.insurancePolicyCoverage && (
                                    <p className="text-xs text-emerald-700 mt-1.5 font-medium">
                                        ✓ Sum insured: {insurancePolicyCoverage}
                                    </p>
                                )}
                                <p className="text-xs text-gray-400 mt-2 leading-relaxed">
                                    Used to recommend hospitals that are compatible with the patient's insurance coverage in future versions.
                                </p>
                            </div>
                        </div>
                    )}

                    {/* No-insurance acknowledgement */}
                    {hasInsurance === false && (
                        <div className="flex items-center gap-2 mt-1 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                            <svg className="w-4 h-4 text-amber-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                            </svg>
                            <span className="text-xs text-amber-800">
                                No insurance recorded. Government scheme eligibility (PMJAY / Ayushman Bharat) may apply at the receiving hospital.
                            </span>
                        </div>
                    )}
                </section>

                {/* Submit Button */}
                <button
                    className="btn btn-primary w-full shadow-lg hover:shadow-xl transform hover:scale-105 transition-all duration-200 flex items-center justify-center gap-2"
                    type="submit"
                    disabled={loading}
                >
                    {loading ? (
                        <>
                            <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="m4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                            </svg>
                            Dispatching…
                        </>
                    ) : (
                        <>
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                            </svg>
                            {tSubmitCase}
                        </>
                    )}
                </button>

                {/* Status Messages */}
                {status && (
                    <div className={`p-4 rounded-lg border ${status.includes('successfully') || status.includes('Offline')
                        ? 'bg-green-50 border-green-200 text-green-800'
                        : status.includes('Error') || status.includes('fix validation')
                            ? 'bg-red-50 border-red-200 text-red-800'
                            : 'bg-blue-50 border-blue-200 text-blue-800'
                        }`}>
                        <div className="flex items-center gap-2">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                {status.includes('successfully') || status.includes('Offline') ? (
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                ) : status.includes('Error') || status.includes('fix validation') ? (
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                ) : (
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                                )}
                            </svg>
                            <span className="text-sm font-medium">{status}</span>
                        </div>
                    </div>
                )}
                {/* Dispatch Summary Card — shown after successful dispatch */}
                {dispatchSummary && (
                    <div style={{
                        background: 'linear-gradient(135deg, #0f172a, #1e293b)',
                        border: '1px solid #22c55e',
                        borderRadius: '12px',
                        padding: '20px',
                        marginTop: '8px',
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '16px' }}>
                            <span style={{ fontSize: '22px' }}>🚑</span>
                            <div>
                                <div style={{ color: '#22c55e', fontWeight: 800, fontSize: '16px', letterSpacing: '0.04em' }}>EMERGENCY DISPATCH CREATED</div>
                                <div style={{ color: '#64748b', fontSize: '12px' }}>{dispatchSummary.timestamp}</div>
                            </div>
                            <button
                                type="button"
                                onClick={() => setDispatchSummary(null)}
                                style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', fontSize: '18px' }}
                            >✕</button>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                            {[
                                { label: 'Case ID', value: dispatchSummary.caseId, icon: '🆔' },
                                { label: 'Severity', value: dispatchSummary.acuityLabel, icon: '⚠️' },
                                { label: 'Ambulance Type', value: dispatchSummary.ambulanceType, icon: '🚑' },
                                { label: 'Ambulance ID', value: dispatchSummary.ambulanceId, icon: '🔢' },
                                { label: 'Driver', value: dispatchSummary.driver, icon: '👤' },
                                { label: 'Paramedic', value: dispatchSummary.paramedic, icon: '🩺' },
                                { label: 'ETA to Patient', value: `${dispatchSummary.eta} minutes`, icon: '⏱️' },
                                { label: 'Status', value: 'En Route to Patient', icon: '✅' },
                            ].map(({ label, value, icon }) => (
                                <div key={label} style={{
                                    background: '#0f172a',
                                    border: '1px solid #1e293b',
                                    borderRadius: '8px',
                                    padding: '10px 12px',
                                }}>
                                    <div style={{ color: '#64748b', fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em' }}>
                                        {icon} {label}
                                    </div>
                                    <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '13px', marginTop: '4px' }}>
                                        {value}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}

            </form>
        </div>
    );
}
