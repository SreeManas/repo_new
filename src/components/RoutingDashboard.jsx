// src/components/RoutingDashboard.jsx
/**
 * Routing Intelligence Dashboard v1.0
 * 
 * Emergency command interface for ambulance routing visualization.
 * Displays ranked hospitals, routes, ETA comparisons, and real-time updates.
 */

import React, { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import { getFirestore, collection, onSnapshot, query, orderBy, limit, where, doc } from "firebase/firestore";
import { rankHospitals, getTopRecommendations, calculateDistanceKm, normalizeHospital } from "../services/capabilityScoringEngine.js";
import { buildClinicalRoutingContext } from "../services/qrRelevanceLayer.js";
import {
    MapPin, Clock, AlertTriangle, Building2, Heart, Activity,
    Navigation, Zap, Users, ChevronRight, Timer, RefreshCw, Layers,
    Ambulance, Phone, CheckCircle, XCircle, Info, ShieldAlert, FileText
} from "lucide-react";
import { useMapResize } from "../hooks/useMapResize";
import { useTPreload, useTBatch } from "../hooks/useT";
import { PRELOAD_ROUTING } from "../constants/translationKeys";
import RoutingStatusBanner from "./RoutingStatusBanner.jsx";
import HospitalExplainabilityPanel from "./HospitalExplainabilityPanel.jsx";
import DispatcherOverridePanel from "./DispatcherOverridePanel.jsx";
import OverrideAuditPanel from "./OverrideAuditPanel.jsx";
import { useAuth } from "./auth/AuthProvider.jsx";
import { dispatchHospitalNotification } from "../services/hospitalResponseEngine.js";

mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN || "";

// =============================================================================
// CONSTANTS
// =============================================================================

const DEFAULT_CENTER = [77.5946, 12.9716]; // Bangalore
const DEFAULT_ZOOM = 11;

const ROUTE_COLORS = {
    primary: "#22c55e",   // Green - top pick
    secondary: "#eab308", // Yellow - 2nd
    tertiary: "#ef4444",  // Red - 3rd
    override: "#2563eb"   // Phase 2: Blue - override active
};

const MARKER_COLORS = {
    top: "#22c55e",
    moderate: "#eab308",
    low: "#ef4444",
    disqualified: "#6b7280"
};

const OSM_STYLE = {
    version: 8,
    sources: {
        osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "© OpenStreetMap contributors",
        },
    },
    layers: [{ id: "osm", type: "raster", source: "osm" }],
};

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

function formatTimeSince(timestamp) {
    if (!timestamp) return "Unknown";

    let ts;
    if (timestamp._seconds) ts = timestamp._seconds * 1000;
    else if (timestamp.toMillis) ts = timestamp.toMillis();
    else ts = new Date(timestamp).getTime();

    const mins = Math.floor((Date.now() - ts) / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
}

function getGoldenHourRemaining(timestamp) {
    if (!timestamp) return null;

    let ts;
    if (timestamp._seconds) ts = timestamp._seconds * 1000;
    else if (timestamp.toMillis) ts = timestamp.toMillis();
    else ts = new Date(timestamp).getTime();

    const elapsed = (Date.now() - ts) / 60000;
    const remaining = 60 - elapsed;

    return remaining > 0 ? Math.round(remaining) : null;
}

function getMarkerColor(rank, total) {
    if (rank === 1) return MARKER_COLORS.top;
    if (rank <= 3) return MARKER_COLORS.moderate;
    return MARKER_COLORS.low;
}

function getAcuityLabel(level) {
    const labels = {
        5: { text: "CRITICAL", color: "bg-red-600" },
        4: { text: "SEVERE", color: "bg-orange-500" },
        3: { text: "MODERATE", color: "bg-yellow-500" },
        2: { text: "MILD", color: "bg-blue-500" },
        1: { text: "MINOR", color: "bg-green-500" }
    };
    return labels[level] || { text: "UNKNOWN", color: "bg-gray-500" };
}

function getLoadColor(status) {
    if (status === "full" || status === "critical") return "bg-red-500";
    if (status === "diverting" || status === "busy") return "bg-orange-500";
    return "bg-green-500";
}

// =============================================================================
// MAIN COMPONENT
// =============================================================================

const ROUTING_LABELS = [
    "Hospital Ranking", "#1 Recommended", "#2-3 Suitable", "#4+ Lower Priority",
    "Disqualified", "Route Lines", "Primary Route", "Secondary", "Tertiary",
    "Calculating routes...", "Active Emergency", "Type:", "Acuity:", "Patient:",
    "Time:", "Ranked Hospitals", "Score", "Go To Hospital", "Unknown",
    "Just now", "Emergency", "Map failed to load"
];

export default function RoutingDashboard() {
    // Phase 10: Preload translations for this dashboard
    useTPreload(PRELOAD_ROUTING);

    // Phase 5: Batch translate all static UI labels
    const { translated: t } = useTBatch(ROUTING_LABELS);
    const T = {
        hospitalRanking: t[0], recommended: t[1], suitable: t[2], lowerPriority: t[3],
        disqualified: t[4], routeLines: t[5], primaryRoute: t[6], secondary: t[7], tertiary: t[8],
        calculatingRoutes: t[9], activeEmergency: t[10], type: t[11], acuity: t[12], patient: t[13],
        time: t[14], rankedHospitals: t[15], score: t[16], goToHospital: t[17], unknown: t[18],
        justNow: t[19], emergency: t[20], mapFailed: t[21]
    };
    const { role } = useAuth();
    const routerNavigate = useNavigate();
    const mapRef = useRef(null);
    const containerRef = useRef(null);
    const markersRef = useRef([]);
    const routeSourcesRef = useRef([]);

    // Map state
    const [mapLoaded, setMapLoaded] = useState(false);
    const [mapError, setMapError] = useState("");

    // Data state
    const [emergencyCases, setEmergencyCases] = useState([]);
    const [hospitals, setHospitals] = useState([]);
    const [selectedCase, setSelectedCase] = useState(null);
    const [selectedHospital, setSelectedHospital] = useState(null);
    const [rankedHospitals, setRankedHospitals] = useState([]);
    const [routes, setRoutes] = useState({});

    // UI state
    const [showCompareMode, setShowCompareMode] = useState(true);
    const [isLoadingRoutes, setIsLoadingRoutes] = useState(false);
    const [goldenHourRemaining, setGoldenHourRemaining] = useState(null);
    const [routingState, setRoutingState] = useState("idle"); // idle, evaluating, hospital_selected, en_route

    // Phase 5B: Debounce state for routing recompute
    const [isRecomputing, setIsRecomputing] = useState(false);
    const [scoringLastRun, setScoringLastRun] = useState(null);
    const [capacityLastUpdated, setCapacityLastUpdated] = useState(null);
    const recomputeTimeoutRef = useRef(null);

    // Phase 2: Override priority enforcement state
    const [activeOverride, setActiveOverride] = useState(null);
    const [showAuditTab, setShowAuditTab] = useState(false);

    // Manual refresh
    const [refreshKey, setRefreshKey] = useState(0);
    const [isManualRefreshing, setIsManualRefreshing] = useState(false);
    const [lastRefreshedAt, setLastRefreshedAt] = useState(null);

    const handleManualRefresh = useCallback(() => {
        setIsManualRefreshing(true);
        setRoutes({});               // clear cached routes so they re-fetch
        setRankedHospitals([]);      // force re-rank
        setRefreshKey(k => k + 1);  // bump key → re-subscribe Firestore
        setTimeout(() => {
            setIsManualRefreshing(false);
            setLastRefreshedAt(Date.now());
        }, 1500);
    }, []);

    // Phase 5: Mapbox resize debounce ref
    const resizeTimeoutRef = useRef(null);

    const db = getFirestore();

    // =============================================================================
    // FIRESTORE LISTENERS
    // =============================================================================

    // Listen to emergency cases
    useEffect(() => {
        const q = query(
            collection(db, "emergencyCases"),
            orderBy("createdAt", "desc"),
            limit(10)
        );

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const cases = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));
            setEmergencyCases(cases);

            // Auto-select first case if none selected
            if (!selectedCase && cases.length > 0) {
                setSelectedCase(cases[0]);
            }
        }, (error) => {
            console.error("Emergency cases listener error:", error);
        });

        return () => unsubscribe();
    }, [db, selectedCase, refreshKey]); // refreshKey forces re-subscribe on manual refresh

    // Listen to hospitals with debounced scoring (Phase 5B)
    useEffect(() => {
        const unsubscribe = onSnapshot(collection(db, "hospitals"), (snapshot) => {
            const hospitalList = snapshot.docs.map(doc => {
                // MF6: Normalize hospital data to prevent scoring faults
                const raw = { id: doc.id, ...doc.data() };
                return normalizeHospital ? normalizeHospital(raw) || raw : raw;
            });
            setHospitals(hospitalList);

            // Track capacity freshness
            const mostRecent = hospitalList.reduce((latest, h) => {
                const ts = h.capacityLastUpdated?.toMillis?.() || 0;
                return ts > latest ? ts : latest;
            }, 0);
            if (mostRecent > 0) setCapacityLastUpdated(mostRecent);
        }, (error) => {
            console.error("Hospitals listener error:", error);
        });

        return () => unsubscribe();
    }, [db, refreshKey]); // refreshKey forces re-subscribe on manual refresh

    // =============================================================================
    // PHASE 2: OVERRIDE DETECTION — Listen for dispatch overrides on active case
    // =============================================================================
    useEffect(() => {
        if (!selectedCase?.id || selectedCase.id === 'preview') {
            setActiveOverride(null);
            return;
        }

        // Check if case has override embedded (routing.wasOverridden)
        if (selectedCase?.routing?.wasOverridden) {
            setActiveOverride({
                hospitalId: selectedCase.routing.overriddenHospitalId,
                hospitalName: selectedCase.routing.overriddenHospitalName,
                reason: selectedCase.routing.overrideReason,
                timestamp: selectedCase.routing.overriddenAt,
                by: selectedCase.routing.overriddenBy
            });
        } else {
            setActiveOverride(null);
        }
    }, [selectedCase]);

    // Phase 2: Lock hospital selection when override is active
    useEffect(() => {
        if (activeOverride && rankedHospitals.length > 0) {
            const overrideHospital = rankedHospitals.find(
                h => h.hospitalId === activeOverride.hospitalId
            );
            if (overrideHospital) {
                setSelectedHospital(overrideHospital);
            }
        }
    }, [activeOverride, rankedHospitals]);

    // Phase 5: Debounced map resize helper
    const triggerMapResize = useCallback(() => {
        if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
        resizeTimeoutRef.current = setTimeout(() => {
            if (mapRef.current) {
                mapRef.current.resize();
            }
        }, 300);
    }, []);

    // Phase 5: Window resize + orientation change listener
    useEffect(() => {
        const handleResize = () => triggerMapResize();
        window.addEventListener('resize', handleResize);
        window.addEventListener('orientationchange', handleResize);
        return () => {
            window.removeEventListener('resize', handleResize);
            window.removeEventListener('orientationchange', handleResize);
            if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
        };
    }, [triggerMapResize]);

    // =============================================================================
    // SCORING & RANKING
    // =============================================================================

    // Re-rank hospitals when case or hospitals change (with debounce - Phase 5B)
    useEffect(() => {
        if (!selectedCase || hospitals.length === 0) {
            setRankedHospitals([]);
            return;
        }

        // Cancel any pending recompute
        if (recomputeTimeoutRef.current) {
            clearTimeout(recomputeTimeoutRef.current);
        }

        setIsRecomputing(true);
        setRoutingState("evaluating");

        // Debounce by 800ms to prevent UI thrashing
        recomputeTimeoutRef.current = setTimeout(() => {
            // Attach ClinicalRoutingContext when QR history is present.
            // buildClinicalRoutingContext returns { applicable: false } when no QR
            // was scanned — the engine then behaves identically to before.
            const clinicalContext = buildClinicalRoutingContext(selectedCase, selectedCase.patientHistory);
            const caseForRouting = { ...selectedCase, clinicalContext };
            const ranked = rankHospitals(hospitals, caseForRouting);
            setRankedHospitals(ranked);
            setScoringLastRun(Date.now());
            setIsRecomputing(false);

            // Auto-select top hospital
            const topHospital = ranked.find(h => !h.disqualified);
            if (topHospital && !selectedHospital) {
                setSelectedHospital(topHospital);
            }

            setRoutingState("hospital_selected");
        }, 800);

        return () => {
            if (recomputeTimeoutRef.current) {
                clearTimeout(recomputeTimeoutRef.current);
            }
        };
    }, [selectedCase, hospitals]);

    // Golden hour timer
    useEffect(() => {
        if (!selectedCase) return;

        const incidentTime = selectedCase.emergencyContext?.incidentTimestamp ||
            selectedCase.incidentTimestamp;

        const updateGoldenHour = () => {
            const remaining = getGoldenHourRemaining(incidentTime);
            setGoldenHourRemaining(remaining);
        };

        updateGoldenHour();
        const interval = setInterval(updateGoldenHour, 10000); // Every 10 seconds

        return () => clearInterval(interval);
    }, [selectedCase]);

    // =============================================================================
    // MAP INITIALIZATION
    // =============================================================================

    useEffect(() => {
        if (mapRef.current) return;
        const container = containerRef.current;
        if (!container) return;

        // Determine initial center: pickup location > default
        const initialCenter = selectedCase?.pickupLocation
            ? [selectedCase.pickupLocation.longitude, selectedCase.pickupLocation.latitude]
            : DEFAULT_CENTER;

        const initMap = (style) => {
            const map = new mapboxgl.Map({
                container,
                style,
                center: initialCenter,
                zoom: selectedCase?.pickupLocation ? 13 : DEFAULT_ZOOM,
            });

            map.addControl(new mapboxgl.NavigationControl(), "top-right");
            map.addControl(new mapboxgl.ScaleControl(), "bottom-left");

            map.on("load", () => {
                setMapLoaded(true);
                map.resize();
            });

            map.on("error", (e) => {
                console.error("Map error:", e);
                setMapError("Map failed to load");
            });

            mapRef.current = map;
        };

        if (!mapboxgl.accessToken || mapboxgl.accessToken.trim() === "") {
            initMap(OSM_STYLE);
        } else {
            initMap("mapbox://styles/mapbox/dark-v11");
        }

        return () => {
            if (mapRef.current) {
                try { mapRef.current.remove(); } catch { }
                mapRef.current = null;
            }
        };
    }, []);

    // Map Resize Handler (Responsive + Orientation Support)
    useMapResize(mapRef.current);


    // =============================================================================
    // INTELLIGENT VIEWPORT MANAGEMENT
    // =============================================================================

    // Fly to pickup location when selected case changes
    useEffect(() => {
        if (!mapRef.current || !mapLoaded) return;
        if (!selectedCase?.pickupLocation) return;

        const pickup = selectedCase.pickupLocation;

        // If no hospitals yet, fly to pickup with smooth animation
        if (rankedHospitals.length === 0) {
            mapRef.current.flyTo({
                center: [pickup.longitude, pickup.latitude],
                zoom: 14,
                duration: 1500,
                essential: true
            });
        }
    }, [mapLoaded, selectedCase?.pickupLocation, rankedHospitals.length]);

    // Fit bounds when hospitals are ranked (priority: pickup + hospitals)
    useEffect(() => {
        if (!mapRef.current || !mapLoaded) return;
        if (!selectedCase?.pickupLocation || rankedHospitals.length === 0) return;

        const map = mapRef.current;
        const pickup = selectedCase.pickupLocation;
        const bounds = new mapboxgl.LngLatBounds();

        // Add pickup location
        bounds.extend([pickup.longitude, pickup.latitude]);

        // Add top 5 ranked hospitals
        let hospitalCount = 0;
        rankedHospitals.slice(0, 5).forEach(h => {
            const hospitalData = hospitals.find(hosp => hosp.id === h.hospitalId);
            if (hospitalData?.basicInfo?.location) {
                bounds.extend([
                    hospitalData.basicInfo.location.longitude,
                    hospitalData.basicInfo.location.latitude
                ]);
                hospitalCount++;
            }
        });

        // Only fitBounds if we have at least one hospital location
        if (hospitalCount > 0) {
            map.fitBounds(bounds, {
                padding: { top: 60, bottom: 60, left: 60, right: 420 }, // Account for right panel
                maxZoom: 14,
                duration: 1200,
                essential: true
            });
        }
    }, [mapLoaded, selectedCase?.pickupLocation, rankedHospitals, hospitals]);

    // Phase 2: Fit bounds when override becomes active
    useEffect(() => {
        if (!mapRef.current || !mapLoaded || !activeOverride) return;
        const map = mapRef.current;
        const pickup = selectedCase?.pickupLocation;
        if (!pickup) return;

        // Find the override hospital data
        const overrideHospital = rankedHospitals.find(h => h.hospitalId === activeOverride.hospitalId);
        if (!overrideHospital) return;

        const hospitalData = hospitals.find(h => h.id === overrideHospital.hospitalId);
        if (!hospitalData?.basicInfo?.location) return;

        // Create bounds that include pickup and override hospital
        const bounds = new mapboxgl.LngLatBounds();
        bounds.extend([pickup.longitude, pickup.latitude]);
        bounds.extend([
            hospitalData.basicInfo.location.longitude,
            hospitalData.basicInfo.location.latitude
        ]);

        map.fitBounds(bounds, {
            padding: { top: 80, bottom: 80, left: 80, right: 420 }, // Account for right panel
            maxZoom: 14,
            duration: 1000,
            essential: true
        });
    }, [mapLoaded, activeOverride, selectedCase?.pickupLocation, rankedHospitals, hospitals]);

    // Fly to selected hospital when clicked in panel
    useEffect(() => {
        if (!mapRef.current || !mapLoaded || !selectedHospital) return;

        const hospitalData = hospitals.find(h => h.id === selectedHospital.hospitalId);
        if (!hospitalData?.basicInfo?.location) return;

        const loc = hospitalData.basicInfo.location;
        const pickup = selectedCase?.pickupLocation;

        // Create bounds from pickup to selected hospital
        if (pickup) {
            const bounds = new mapboxgl.LngLatBounds();
            bounds.extend([pickup.longitude, pickup.latitude]);
            bounds.extend([loc.longitude, loc.latitude]);

            mapRef.current.fitBounds(bounds, {
                padding: { top: 80, bottom: 80, left: 80, right: 420 },
                maxZoom: 14,
                duration: 800,
                essential: true
            });
        } else {
            // Just fly to hospital if no pickup
            mapRef.current.flyTo({
                center: [loc.longitude, loc.latitude],
                zoom: 15,
                duration: 800,
                essential: true
            });
        }
    }, [mapLoaded, selectedHospital, hospitals, selectedCase?.pickupLocation]);

    // =============================================================================
    // ROUTE FETCHING
    // =============================================================================

    const fetchRoute = useCallback(async (pickup, hospital) => {
        if (!mapboxgl.accessToken) return null;

        const key = `${pickup.latitude},${pickup.longitude}-${hospital.latitude},${hospital.longitude}`;
        if (routes[key]) return routes[key];

        try {
            const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${pickup.longitude},${pickup.latitude};${hospital.longitude},${hospital.latitude}?geometries=geojson&overview=full&access_token=${mapboxgl.accessToken}`;

            const response = await fetch(url);
            const data = await response.json();

            if (data.routes && data.routes[0]) {
                const route = data.routes[0].geometry;
                setRoutes(prev => ({ ...prev, [key]: route }));
                return route;
            }
        } catch (error) {
            console.error("Route fetch error:", error);
        }
        return null;
    }, [routes]);

    // Fetch routes for top 3 hospitals
    useEffect(() => {
        if (!selectedCase?.pickupLocation || rankedHospitals.length === 0) return;
        if (!mapboxgl.accessToken) return;

        const fetchTopRoutes = async () => {
            setIsLoadingRoutes(true);
            const top3 = rankedHospitals.filter(h => !h.disqualified).slice(0, 3);

            // Fetch routes for top 3 AI recommendations
            for (const hospital of top3) {
                const hospitalData = hospitals.find(h => h.id === hospital.hospitalId);
                if (hospitalData?.basicInfo?.location) {
                    await fetchRoute(selectedCase.pickupLocation, hospitalData.basicInfo.location);
                }
            }

            // Phase 2: Also fetch route for override hospital if it exists and is not in top 3
            if (activeOverride && activeOverride.hospitalId) {
                const overrideHospital = rankedHospitals.find(h => h.hospitalId === activeOverride.hospitalId);
                const isInTop3 = top3.some(h => h.hospitalId === activeOverride.hospitalId);

                if (overrideHospital && !isInTop3) {
                    const hospitalData = hospitals.find(h => h.id === overrideHospital.hospitalId);
                    if (hospitalData?.basicInfo?.location) {
                        await fetchRoute(selectedCase.pickupLocation, hospitalData.basicInfo.location);
                    }
                }
            }

            setIsLoadingRoutes(false);
        };

        fetchTopRoutes();
    }, [selectedCase, rankedHospitals, hospitals, fetchRoute, activeOverride]);

    // =============================================================================
    // MAP RENDERING
    // =============================================================================

    // Render ambulance marker and hospital markers
    useEffect(() => {
        if (!mapRef.current || !mapLoaded) return;
        const map = mapRef.current;

        // Clear existing markers
        markersRef.current.forEach(m => m.remove());
        markersRef.current = [];

        // Clear existing route sources
        routeSourcesRef.current.forEach(id => {
            if (map.getLayer(id)) map.removeLayer(id);
            if (map.getSource(id)) map.removeSource(id);
        });
        routeSourcesRef.current = [];

        if (!selectedCase?.pickupLocation) return;

        const pickup = selectedCase.pickupLocation;
        const acuity = getAcuityLabel(selectedCase.acuityLevel);

        // Create ambulance marker (pickup location)
        const ambulanceEl = document.createElement("div");
        ambulanceEl.className = "ambulance-marker";
        ambulanceEl.innerHTML = `
      <div class="relative">
        <div class="absolute -inset-4 bg-red-500 rounded-full animate-ping opacity-30"></div>
        <div class="relative w-10 h-10 bg-gradient-to-br from-red-500 to-red-700 rounded-full flex items-center justify-center shadow-lg border-2 border-white">
          <span class="text-white text-lg">🚑</span>
        </div>
      </div>
    `;

        const ambulanceMarker = new mapboxgl.Marker({ element: ambulanceEl })
            .setLngLat([pickup.longitude, pickup.latitude])
            .setPopup(new mapboxgl.Popup({ offset: 25 }).setHTML(`
        <div class="p-3 min-w-[200px]">
          <div class="flex items-center gap-2 mb-2">
            <span class="text-xl">🚑</span>
            <strong class="text-lg">Pickup Location</strong>
          </div>
          <div class="space-y-2 text-sm">
            <div class="flex justify-between">
              <span class="text-gray-600">Emergency:</span>
              <span class="font-medium">${selectedCase.emergencyContext?.emergencyType || "Unknown"}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-600">Acuity:</span>
              <span class="px-2 py-0.5 rounded text-white text-xs ${acuity.color}">${acuity.text}</span>
            </div>
            <div class="flex justify-between">
              <span class="text-gray-600">Time:</span>
              <span class="font-medium">${formatTimeSince(selectedCase.emergencyContext?.incidentTimestamp)}</span>
            </div>
            ${goldenHourRemaining ? `
              <div class="flex justify-between text-red-600">
                <span>⏱️ Golden Hour:</span>
                <span class="font-bold">${goldenHourRemaining}min left</span>
              </div>
            ` : ""}
          </div>
        </div>
      `))
            .addTo(map);

        markersRef.current.push(ambulanceMarker);

        // Create hospital markers
        rankedHospitals.forEach((scored, index) => {
            const hospitalData = hospitals.find(h => h.id === scored.hospitalId);
            if (!hospitalData?.basicInfo?.location) return;

            const loc = hospitalData.basicInfo.location;
            const rank = index + 1;
            const color = scored.disqualified ? MARKER_COLORS.disqualified : getMarkerColor(rank, rankedHospitals.length);
            const loadStatus = hospitalData.emergencyReadiness?.status || "available";

            const hospitalEl = document.createElement("div");
            hospitalEl.className = "hospital-marker";
            hospitalEl.innerHTML = `
        <div class="relative cursor-pointer transition-transform hover:scale-110" data-hospital-id="${scored.hospitalId}">
          <div class="w-8 h-8 rounded-full flex items-center justify-center shadow-lg border-2 border-white" 
               style="background: ${color}">
            <span class="text-white text-sm font-bold">${scored.disqualified ? "✕" : rank}</span>
          </div>
          ${rank <= 3 && !scored.disqualified ? `
            <div class="absolute -top-1 -right-1 w-3 h-3 rounded-full ${getLoadColor(loadStatus)}"></div>
          ` : ""}
        </div>
      `;

            const marker = new mapboxgl.Marker({ element: hospitalEl })
                .setLngLat([loc.longitude, loc.latitude])
                .setPopup(new mapboxgl.Popup({ offset: 25, maxWidth: "300px" }).setHTML(`
          <div class="p-3 min-w-[250px]">
            <div class="flex items-center justify-between mb-2">
              <strong class="text-lg">${scored.hospitalName}</strong>
              <span class="px-2 py-1 rounded text-white text-xs font-bold" style="background: ${color}">
                ${scored.disqualified ? "EXCLUDED" : `#${rank}`}
              </span>
            </div>
            ${scored.disqualified ? `
              <div class="bg-red-50 text-red-700 p-2 rounded text-sm mb-2">
                ${scored.disqualifyReasons?.join(", ") || "Disqualified"}
              </div>
            ` : `
              <div class="space-y-2 text-sm">
                <div class="flex justify-between">
                  <span class="text-gray-600">Score:</span>
                  <span class="font-bold text-lg">${scored.suitabilityScore}</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-gray-600">Distance:</span>
                  <span>${scored.distanceKm} km</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-gray-600">ETA:</span>
                  <span class="font-medium">${scored.etaMinutes} min</span>
                </div>
                <div class="flex justify-between">
                  <span class="text-gray-600">Trauma Level:</span>
                  <span>${scored.traumaLevel?.replace("_", " ").toUpperCase() || "N/A"}</span>
                </div>
              </div>
              <div class="mt-3 pt-2 border-t border-gray-200">
                <div class="text-xs text-gray-500 mb-1">Recommendation:</div>
                <div class="text-sm text-gray-700">
                  ${scored.recommendationReasons?.slice(0, 3).join(" • ") || ""}
                </div>
              </div>
            `}
          </div>
        `))
                .addTo(map);

            // Click handler
            hospitalEl.addEventListener("click", () => {
                setSelectedHospital(scored);
            });

            markersRef.current.push(marker);
        });

        // Draw routes — Phase 2: Override priority enforcement
        // Override > AI recommendation > Distance fallback
        const top3 = rankedHospitals.filter(h => !h.disqualified).slice(0, 3);

        // Phase 2: If override is active and not in top 3, add it to routes to render
        const hospitalsToRender = [...top3];
        if (activeOverride && activeOverride.hospitalId) {
            const isInTop3 = top3.some(h => h.hospitalId === activeOverride.hospitalId);
            if (!isInTop3) {
                const overrideHospital = rankedHospitals.find(h => h.hospitalId === activeOverride.hospitalId);
                if (overrideHospital) {
                    hospitalsToRender.push(overrideHospital);
                }
            }
        }

        hospitalsToRender.forEach((hospital, index) => {
            const hospitalData = hospitals.find(h => h.id === hospital.hospitalId);
            if (!hospitalData?.basicInfo?.location) return;

            const key = `${pickup.latitude},${pickup.longitude}-${hospitalData.basicInfo.location.latitude},${hospitalData.basicInfo.location.longitude}`;
            const routeGeo = routes[key];

            if (!routeGeo) return;

            const sourceId = `route-${hospital.hospitalId}`; // Use hospital ID instead of index for stability
            const isOverrideRoute = activeOverride && hospital.hospitalId === activeOverride.hospitalId;

            // Phase 2: Override route = BLUE, AI routes fade when override active
            let color, width, opacity;
            if (isOverrideRoute) {
                color = ROUTE_COLORS.override;  // Blue for override
                width = 7;
                opacity = 1.0;
            } else if (activeOverride) {
                // AI routes fade when override is active
                const aiIndex = top3.findIndex(h => h.hospitalId === hospital.hospitalId);
                color = aiIndex === 0 ? ROUTE_COLORS.primary : (aiIndex === 1 ? ROUTE_COLORS.secondary : ROUTE_COLORS.tertiary);
                width = 3;
                opacity = 0.25;  // Heavily faded
            } else {
                color = index === 0 ? ROUTE_COLORS.primary : (index === 1 ? ROUTE_COLORS.secondary : ROUTE_COLORS.tertiary);
                width = index === 0 ? 6 : 4;
                opacity = showCompareMode || index === 0 ? 0.8 : 0.3;
            }

            if (!map.getSource(sourceId)) {
                map.addSource(sourceId, {
                    type: "geojson",
                    data: {
                        type: "Feature",
                        geometry: routeGeo
                    }
                });

                map.addLayer({
                    id: sourceId,
                    type: "line",
                    source: sourceId,
                    layout: {
                        "line-join": "round",
                        "line-cap": "round"
                    },
                    paint: {
                        "line-color": color,
                        "line-width": width,
                        "line-opacity": opacity
                    }
                });

                routeSourcesRef.current.push(sourceId);
            }
        });

        // Note: Viewport management handled by dedicated useEffects above
        // (flyTo on case selection, fitBounds on hospital ranking, fly on hospital click)

    }, [mapLoaded, selectedCase, rankedHospitals, hospitals, routes, showCompareMode, goldenHourRemaining, activeOverride]);

    // =============================================================================
    // RENDER
    // =============================================================================

    const topRecommendation = rankedHospitals.find(h => !h.disqualified);

    return (
        <div className="min-h-screen bg-gray-900 flex flex-col">
            {/* Phase 2: Decision Banner — Override takes priority over AI */}
            {activeOverride ? (
                <div className="bg-gradient-to-r from-blue-600 via-blue-700 to-indigo-700 text-white px-4 py-2 shadow-lg overflow-hidden">
                    <div className="max-w-7xl mx-auto flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                            <ShieldAlert className="w-5 h-5 flex-shrink-0" />
                            <span className="font-bold text-xs sm:text-sm whitespace-nowrap">OVERRIDE</span>
                            <span className="font-semibold text-sm truncate">{activeOverride.hospitalName}</span>
                        </div>
                        <div className="flex items-center gap-1.5 bg-amber-500 px-2.5 py-1 rounded-md flex-shrink-0">
                            <AlertTriangle className="w-3.5 h-3.5" />
                            <span className="font-bold text-xs">Active</span>
                        </div>
                    </div>
                </div>
            ) : topRecommendation ? (
                <div className="bg-gradient-to-r from-emerald-600 via-emerald-700 to-teal-700 text-white px-4 py-2 shadow-lg overflow-hidden">
                    <div className="max-w-7xl mx-auto flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                            <CheckCircle className="w-5 h-5 flex-shrink-0" />
                            <span className="font-bold text-xs flex-shrink-0">REC:</span>
                            <span className="font-semibold text-sm truncate">{topRecommendation.hospitalName}</span>
                            <span className="bg-white/20 px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 hidden sm:inline">
                                ETA: {topRecommendation.etaMinutes}min
                            </span>
                            <span className="bg-white/20 px-2 py-0.5 rounded-full text-xs font-medium flex-shrink-0 hidden sm:inline">
                                Score: {topRecommendation.suitabilityScore}%
                            </span>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                            {/* Mobile-only compact badges */}
                            <span className="bg-white/20 px-2 py-0.5 rounded-full text-xs font-medium sm:hidden">
                                {topRecommendation.etaMinutes}min · {topRecommendation.suitabilityScore}%
                            </span>
                            {goldenHourRemaining && (
                                <div className="flex items-center gap-1 bg-red-500 px-2 py-1 rounded-md animate-pulse">
                                    <Timer className="w-3.5 h-3.5" />
                                    <span className="font-bold text-xs">⏱{goldenHourRemaining}m</span>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            ) : null}

            {/* Header — Row 1: Title + State */}
            <div className="bg-gray-800 border-b border-gray-700 px-4 py-3">
                <div className="max-w-7xl mx-auto space-y-2">
                    {/* Row 1: Logo, title, routing state */}
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3 min-w-0">
                            <div className="w-8 h-8 bg-gradient-to-br from-red-500 to-orange-600 rounded-lg flex items-center justify-center flex-shrink-0">
                                <Navigation className="w-4 h-4 text-white" />
                            </div>
                            <div className="min-w-0">
                                <h1 className="text-base sm:text-xl font-bold text-white truncate">Routing Dashboard</h1>
                            </div>
                        </div>
                        <div className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium ${routingState === "evaluating" ? "bg-yellow-500/20 text-yellow-400" :
                            routingState === "hospital_selected" ? "bg-green-500/20 text-green-400" :
                                "bg-gray-700 text-gray-400"
                            }`}>
                            <Activity className="w-3.5 h-3.5" />
                            <span className="capitalize">{routingState.replace("_", " ")}</span>
                        </div>
                    </div>

                    {/* Row 2: Action buttons */}
                    <div className="flex items-center gap-2">
                        <button
                            onClick={() => setShowCompareMode(!showCompareMode)}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors text-xs font-medium ${showCompareMode
                                ? "bg-blue-600 text-white"
                                : "bg-gray-700 text-gray-300"
                                }`}
                        >
                            <Layers className="w-3.5 h-3.5" />
                            Compare
                        </button>

                        <button
                            onClick={handleManualRefresh}
                            disabled={isManualRefreshing}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-all text-xs font-medium ${isManualRefreshing
                                ? 'bg-emerald-600/30 text-emerald-400 cursor-not-allowed'
                                : 'bg-gray-700 text-gray-300'
                                }`}
                        >
                            <RefreshCw className={`w-3.5 h-3.5 ${isManualRefreshing ? 'animate-spin' : ''}`} />
                            {isManualRefreshing ? 'Syncing...' : 'Refresh'}
                        </button>

                        {/* Desktop-only: full status banner */}
                        <div className="hidden md:flex flex-1 justify-end">
                            <RoutingStatusBanner
                                capacityLastUpdated={capacityLastUpdated}
                                scoringLastRun={scoringLastRun}
                                isRecomputing={isRecomputing}
                                hospitalCount={hospitals.length}
                                lastRefreshedAt={lastRefreshedAt}
                            />
                        </div>
                    </div>

                    {/* Mobile-only: compact status */}
                    <div className="md:hidden">
                        <RoutingStatusBanner
                            capacityLastUpdated={capacityLastUpdated}
                            scoringLastRun={scoringLastRun}
                            isRecomputing={isRecomputing}
                            hospitalCount={hospitals.length}
                            lastRefreshedAt={lastRefreshedAt}
                        />
                    </div>
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
                {/* Map Container */}
                <div className="flex-1 relative" style={{ minHeight: '50vh' }}>
                    <div
                        ref={containerRef}
                        className="absolute inset-0"
                    />

                    {/* Map Loading */}
                    {!mapLoaded && (
                        <div className="absolute inset-0 flex items-center justify-center bg-gray-900/80">
                            <div className="flex items-center gap-3 text-white">
                                <RefreshCw className="w-6 h-6 animate-spin" />
                                <span>Loading map...</span>
                            </div>
                        </div>
                    )}

                    {/* Legend — hidden on mobile, shown on md+ */}
                    <div className="hidden md:block absolute bottom-4 right-4 sm:bottom-6 sm:right-6 bg-gray-800/95 backdrop-blur rounded-xl border border-gray-700 p-3 sm:p-4 shadow-xl max-w-xs">
                        <h4 className="text-white font-medium mb-3 text-sm">{T.hospitalRanking}</h4>
                        <div className="space-y-2">
                            <div className="flex items-center gap-2">
                                <div className="w-4 h-4 rounded-full" style={{ background: MARKER_COLORS.top }}></div>
                                <span className="text-gray-300 text-sm">{T.recommended}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-4 h-4 rounded-full" style={{ background: MARKER_COLORS.moderate }}></div>
                                <span className="text-gray-300 text-sm">{T.suitable}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-4 h-4 rounded-full" style={{ background: MARKER_COLORS.low }}></div>
                                <span className="text-gray-300 text-sm">{T.lowerPriority}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <div className="w-4 h-4 rounded-full" style={{ background: MARKER_COLORS.disqualified }}></div>
                                <span className="text-gray-300 text-sm">{T.disqualified}</span>
                            </div>
                        </div>

                        <div className="mt-4 pt-3 border-t border-gray-700">
                            <h4 className="text-white font-medium mb-2 text-sm">{T.routeLines}</h4>
                            <div className="space-y-2">
                                {/* Phase 2: Show override route in legend when active */}
                                {activeOverride && (
                                    <div className="flex items-center gap-2">
                                        <div className="w-8 h-1 rounded" style={{ background: ROUTE_COLORS.override }}></div>
                                        <span className="text-blue-300 text-sm font-medium">Manual Override</span>
                                    </div>
                                )}
                                <div className="flex items-center gap-2">
                                    <div className="w-8 h-1 rounded" style={{ background: ROUTE_COLORS.primary }}></div>
                                    <span className="text-gray-300 text-sm">{T.primaryRoute}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <div className="w-8 h-1 rounded" style={{ background: ROUTE_COLORS.secondary }}></div>
                                    <span className="text-gray-300 text-sm">{T.secondary}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <div className="w-8 h-1 rounded" style={{ background: ROUTE_COLORS.tertiary }}></div>
                                    <span className="text-gray-300 text-sm">{T.tertiary}</span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Loading Routes Indicator */}
                    {isLoadingRoutes && (
                        <div className="absolute top-6 left-6 bg-blue-500/20 border border-blue-500/50 text-blue-400 px-4 py-2 rounded-lg flex items-center gap-2">
                            <RefreshCw className="w-4 h-4 animate-spin" />
                            <span className="text-sm">{T.calculatingRoutes}</span>
                        </div>
                    )}
                </div>

                {/* Right Panel - ETA & Hospital List */}
                <div className="w-full lg:w-96 bg-gray-800 border-t lg:border-t-0 lg:border-l border-gray-700 overflow-y-auto">
                    {/* Case Selector */}
                    {emergencyCases.length > 1 && (
                        <div className="p-4 border-b border-gray-700">
                            <label className="block text-gray-400 text-sm mb-2">{T.activeEmergency}</label>
                            <select
                                value={selectedCase?.id || ""}
                                onChange={(e) => {
                                    const c = emergencyCases.find(ec => ec.id === e.target.value);
                                    setSelectedCase(c);
                                    setSelectedHospital(null);
                                }}
                                className="w-full bg-gray-700 border border-gray-600 text-white rounded-lg px-3 py-2"
                            >
                                {emergencyCases.map(c => (
                                    <option key={c.id} value={c.id}>
                                        {c.emergencyContext?.emergencyType || "Emergency"} - {c.patientInfo?.name || "Unknown"}
                                    </option>
                                ))}
                            </select>
                        </div>
                    )}

                    {/* Selected Case Info */}
                    {selectedCase && (
                        <div className="p-4 border-b border-gray-700 bg-gray-750">
                            <div className="flex items-center justify-between mb-3">
                                <h3 className="font-semibold text-white flex items-center gap-2">
                                    <AlertTriangle className="w-5 h-5 text-red-500" />
                                    {T.activeEmergency}
                                </h3>
                                {goldenHourRemaining && (
                                    <span className="bg-red-500 text-white text-xs px-2 py-1 rounded animate-pulse">
                                        ⏱️ {goldenHourRemaining}m
                                    </span>
                                )}
                            </div>
                            <div className="grid grid-cols-2 gap-3 text-sm">
                                <div>
                                    <span className="text-gray-400">{T.type}</span>
                                    <p className="text-white font-medium">{selectedCase.emergencyContext?.emergencyType || "Unknown"}</p>
                                </div>
                                <div>
                                    <span className="text-gray-400">{T.acuity}</span>
                                    <p className={`font-medium ${getAcuityLabel(selectedCase.acuityLevel).color.replace("bg-", "text-")}`}>
                                        {getAcuityLabel(selectedCase.acuityLevel).text}
                                    </p>
                                </div>
                                <div>
                                    <span className="text-gray-400">{T.patient}</span>
                                    <p className="text-white">{selectedCase.patientInfo?.name || "Unknown"}</p>
                                </div>
                                <div>
                                    <span className="text-gray-400">{T.time}</span>
                                    <p className="text-white">{formatTimeSince(selectedCase.emergencyContext?.incidentTimestamp)}</p>
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Ranked Hospitals */}
                    <div className="p-4">
                        <h3 className="font-semibold text-white mb-4 flex items-center gap-2">
                            <Building2 className="w-5 h-5 text-blue-400" />
                            {T.rankedHospitals} ({rankedHospitals.filter(h => !h.disqualified).length})
                        </h3>

                        <div className="space-y-3">
                            {(() => {
                                // Phase 2: Include override hospital even if not in top 5
                                const top5 = rankedHospitals.filter(h => !h.disqualified).slice(0, 5);
                                const hospitalsToDisplay = [...top5];

                                // Add override hospital if it's not already in top 5
                                if (activeOverride && activeOverride.hospitalId) {
                                    const isInTop5 = top5.some(h => h.hospitalId === activeOverride.hospitalId);
                                    if (!isInTop5) {
                                        const overrideHospital = rankedHospitals.find(h => h.hospitalId === activeOverride.hospitalId);
                                        if (overrideHospital) {
                                            hospitalsToDisplay.push(overrideHospital);
                                        }
                                    }
                                }

                                return hospitalsToDisplay.map((hospital, index) => {
                                    const isSelected = selectedHospital?.hospitalId === hospital.hospitalId;
                                    const hospitalData = hospitals.find(h => h.id === hospital.hospitalId);
                                    const isOverrideHospital = activeOverride && hospital.hospitalId === activeOverride.hospitalId;

                                    return (
                                        <div
                                            key={hospital.hospitalId}
                                            onClick={() => setSelectedHospital(hospital)}
                                            className={`p-4 rounded-xl cursor-pointer transition-all ${isSelected
                                                ? isOverrideHospital
                                                    ? "bg-blue-500/20 border-2 border-blue-500"
                                                    : "bg-emerald-500/20 border-2 border-emerald-500"
                                                : "bg-gray-700/50 border border-gray-600 hover:bg-gray-700"
                                                }`}
                                        >
                                            <div className="flex items-start justify-between mb-2">
                                                <div className="flex items-center gap-2">
                                                    <span
                                                        className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-bold"
                                                        style={{ background: isOverrideHospital ? ROUTE_COLORS.override : getMarkerColor(index + 1, rankedHospitals.length) }}
                                                    >
                                                        {isOverrideHospital ? '⚡' : index + 1}
                                                    </span>
                                                    <span className="font-medium text-white text-sm">{hospital.hospitalName}</span>
                                                    {isOverrideHospital && (
                                                        <span className="px-2 py-0.5 bg-blue-500/30 text-blue-300 text-xs rounded-full font-medium">Override</span>
                                                    )}
                                                </div>
                                                <ChevronRight className={`w-5 h-5 transition-transform ${isSelected ? "rotate-90 text-emerald-400" : "text-gray-500"}`} />
                                            </div>

                                            <div className="grid grid-cols-3 gap-2 text-center">
                                                <div className="bg-gray-800/50 rounded-lg p-2">
                                                    <div className="text-lg font-bold text-white">{hospital.suitabilityScore ?? 0}</div>
                                                    <div className="text-xs text-gray-400">{T.score}</div>
                                                </div>
                                                <div className="bg-gray-800/50 rounded-lg p-2">
                                                    <div className="text-lg font-bold text-blue-400">{hospital.etaMinutes != null && isFinite(hospital.etaMinutes) ? hospital.etaMinutes : '—'}</div>
                                                    <div className="text-xs text-gray-400">min</div>
                                                </div>
                                                <div className="bg-gray-800/50 rounded-lg p-2">
                                                    <div className="text-lg font-bold text-purple-400">{hospital.distanceKm != null && hospital.distanceKm < 999 ? hospital.distanceKm : '—'}</div>
                                                    <div className="text-xs text-gray-400">km</div>
                                                </div>
                                            </div>

                                            {isSelected && (
                                                <div className="mt-3 pt-3 border-t border-gray-600">
                                                    <HospitalExplainabilityPanel hospital={hospital} compact={false} />
                                                    {/* Go To Hospital Navigation Button */}
                                                    {selectedCase && (
                                                        <button
                                                            onClick={async (e) => {
                                                                e.stopPropagation();
                                                                const pickupLoc = selectedCase.pickupLocation || selectedCase.location;
                                                                const hospLoc = hospitalData?.location || hospitalData?.basicInfo?.location;
                                                                const origin = pickupLoc ? [pickupLoc.longitude || pickupLoc.lng, pickupLoc.latitude || pickupLoc.lat] : null;
                                                                const dest = hospLoc ? [hospLoc.longitude || hospLoc.lng, hospLoc.latitude || hospLoc.lat] : null;
                                                                const ambulanceId = `amb_${selectedCase.id || Date.now()}`;
                                                                const trackingLink = `${window.location.origin}/track/${ambulanceId}`;

                                                                // ── HOSPITAL NOTIFICATION DISPATCH ──
                                                                try {
                                                                    const acuity = selectedCase.acuityLevel || selectedCase.aiTriage?.acuityLevel || 3;
                                                                    const eligibleCount = rankedHospitals.filter(h => !h.disqualified).length;
                                                                    console.log('[Dispatch] Sending notification:', {
                                                                        caseId: selectedCase.id,
                                                                        selectedHospitalId: hospital.hospitalId,
                                                                        acuity,
                                                                        eligible: eligibleCount,
                                                                        total: rankedHospitals.length,
                                                                    });

                                                                    // Build list to notify — use ranked list if eligible hospitals exist,
                                                                    // otherwise force-notify the selected hospital directly
                                                                    let listToNotify = rankedHospitals;
                                                                    if (eligibleCount === 0) {
                                                                        console.warn('[Dispatch] All hospitals disqualified — forcing notification to selected hospital:', hospital.hospitalId);
                                                                        listToNotify = [{
                                                                            hospitalId: hospital.hospitalId,
                                                                            hospitalName: hospital.hospitalName,
                                                                            suitabilityScore: hospital.suitabilityScore || 0,
                                                                            disqualified: false,
                                                                        }];
                                                                    }

                                                                    await dispatchHospitalNotification(selectedCase.id, listToNotify, acuity);
                                                                    console.log('[Dispatch] ✅ Notification written for hospitalId:', hospital.hospitalId);
                                                                } catch (err) {
                                                                    console.error('[Dispatch] ❌ Notification write failed:', err.message, err);
                                                                }

                                                                // Trigger navigation
                                                                routerNavigate('/navigate', {
                                                                    state: {
                                                                        caseData: selectedCase,
                                                                        hospitalData: hospital,
                                                                        origin,
                                                                        destination: dest,
                                                                        hospitalName: hospital.hospitalName,
                                                                        ambulanceId,
                                                                        rankedHospitals,  // for auto-reroute on rejection
                                                                        hospitals,        // for re-resolving hospital locations
                                                                    }
                                                                });

                                                                // AUTOMATED COMMUNICATION (non-blocking)
                                                                (async () => {
                                                                    try {
                                                                        // 1. Send dispatch tracking SMS to patient/relatives
                                                                        await sendDispatchTrackingSMS({
                                                                            caseData: selectedCase,
                                                                            ambulanceId,
                                                                            etaMinutes: hospital.eta || 0,
                                                                            trackingLink
                                                                        });

                                                                        // 2. Send hospital alert SMS
                                                                        await sendHospitalAlertSMS({
                                                                            caseData: selectedCase,
                                                                            hospital,
                                                                            etaMinutes: hospital.eta || 0
                                                                        });

                                                                        console.log('✅ Communication automation complete');
                                                                    } catch (err) {
                                                                        console.error('Communication automation error:', err);
                                                                    }
                                                                })();
                                                            }}
                                                            className="mt-3 w-full py-3 bg-gradient-to-r from-emerald-500 to-green-600 hover:from-emerald-600 hover:to-green-700
                                                            text-white font-bold rounded-xl flex items-center justify-center gap-2 shadow-lg
                                                            transition-all hover:shadow-emerald-500/25 hover:scale-[1.02]"
                                                        >
                                                            🚑 {T.goToHospital}
                                                        </button>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    );
                                });
                            })()}
                        </div>

                        {/* Disqualified Hospitals */}
                        {rankedHospitals.filter(h => h.disqualified).length > 0 && (
                            <div className="mt-6">
                                <h4 className="text-gray-400 text-sm mb-3 flex items-center gap-2">
                                    <XCircle className="w-4 h-4" />
                                    {T.disqualified} ({rankedHospitals.filter(h => h.disqualified).length})
                                </h4>
                                <div className="space-y-2">
                                    {rankedHospitals.filter(h => h.disqualified).slice(0, 3).map(hospital => (
                                        <div
                                            key={hospital.hospitalId}
                                            className="p-3 bg-gray-700/30 rounded-lg border border-gray-700"
                                        >
                                            <div className="flex items-center justify-between">
                                                <span className="text-gray-400 text-sm">{hospital.hospitalName}</span>
                                                <span className="text-red-400 text-xs">{hospital.distanceKm} km</span>
                                            </div>
                                            <div className="text-red-400/70 text-xs mt-1">
                                                {hospital.disqualifyReasons?.[0] || "Disqualified"}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Phase-2: Dispatcher Override Panel */}
                    {(role === 'dispatcher' || role === 'admin' || role === 'command_center') && selectedCase && rankedHospitals.length > 0 && (
                        <div className="mt-4">
                            <DispatcherOverridePanel
                                caseId={selectedCase?.id || 'preview'}
                                currentHospital={rankedHospitals.find(h => !h.disqualified)}
                                allHospitals={rankedHospitals}
                                canOverride={role === 'dispatcher' || role === 'admin' || role === 'command_center'}
                                onOverrideComplete={(selectedHospital, overrideDoc) => {
                                    // Immediately activate override state for instant visual feedback
                                    setActiveOverride({
                                        hospitalId: selectedHospital.hospitalId,
                                        hospitalName: selectedHospital.hospitalName,
                                        reason: overrideDoc.reasonText,
                                        timestamp: overrideDoc.timestamp,
                                        by: overrideDoc.overriddenBy
                                    });
                                    // Force hospital selection update
                                    setSelectedHospital(selectedHospital);
                                    // Trigger map resize and refit
                                    triggerMapResize();
                                }}
                            />
                        </div>
                    )}

                    {/* Phase 3: Override Audit Trail Tab */}
                    <div className="border-t border-gray-700 mt-4">
                        <button
                            onClick={() => { setShowAuditTab(!showAuditTab); triggerMapResize(); }}
                            className="w-full flex items-center justify-between px-4 py-3 text-gray-400 hover:text-white hover:bg-gray-700/50 transition-colors"
                        >
                            <div className="flex items-center gap-2">
                                <FileText className="w-4 h-4" />
                                <span className="text-sm font-medium">Override Audit Trail</span>
                            </div>
                            <ChevronRight className={`w-4 h-4 transition-transform ${showAuditTab ? 'rotate-90' : ''}`} />
                        </button>
                        {showAuditTab && (
                            <OverrideAuditPanel caseId={selectedCase?.id} maxEntries={10} />
                        )}
                    </div>
                </div>
            </div>

            {/* CSS for animations */}
            <style>{`
        @keyframes ping {
          75%, 100% {
            transform: scale(2);
            opacity: 0;
          }
        }
        .animate-ping {
          animation: ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite;
        }
      `}</style>
        </div >
    );
}
