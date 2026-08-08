import React, { useEffect, useRef, useState } from 'react';
import { Html5Qrcode } from 'html5-qrcode';
import { Camera, XCircle, CheckCircle, Loader2, AlertCircle } from 'lucide-react';

export default function QRScanner({ onScanSuccess, onScanError, onClose }) {
    const scannerRegionId = "qr-reader";
    const [scanState, setScanState] = useState('initializing');
    const [toastMessage, setToastMessage] = useState(null);
    const scannerRef = useRef(null);
    const startedRef = useRef(false);

    useEffect(() => {
        if (startedRef.current) return;
        startedRef.current = true;

        const html5QrCode = new Html5Qrcode(scannerRegionId);
        scannerRef.current = html5QrCode;
        let isRunning = false;

        const startScanner = async () => {
            try {
                const config = {
                    fps: 10,
                    qrbox: (viewfinderWidth, viewfinderHeight) => {
                        const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
                        const size = Math.min(280, Math.floor(minEdge * 0.8));
                        return { width: size, height: size };
                    }
                };

                await html5QrCode.start(
                    { facingMode: "environment" },
                    config,
                    async (decodedText, decodedResult) => {
                        if (scannerRef.current) {
                            try { await scannerRef.current.stop(); } catch (e) { }
                            isRunning = false;
                        }

                        setScanState('parsing');
                        setToastMessage("Parsing QR data...");
                        await new Promise(res => setTimeout(res, 600));

                        try {
                            JSON.parse(decodedText);
                            setScanState('success');
                            setToastMessage("Patient history loaded successfully!");
                            await new Promise(res => setTimeout(res, 800));
                            if (onScanSuccess) onScanSuccess(decodedText, decodedResult);
                        } catch (e) {
                            setScanState('error');
                            setToastMessage("Invalid QR format. Please scan a patient QR.");
                            setTimeout(() => {
                                setScanState('scanning');
                                setToastMessage(null);
                                startScanner();
                            }, 2500);
                        }
                    },
                    () => { }
                );
                isRunning = true;
                setScanState('scanning');
            } catch (err) {
                console.error("Failed to start QR scanner", err);
                setScanState('error');
                setToastMessage("Camera permission denied or camera not found.");
                startedRef.current = false;
            }
        };

        startScanner();

        return () => {
            startedRef.current = false;
            if (isRunning && scannerRef.current) {
                scannerRef.current.stop()
                    .then(() => scannerRef.current?.clear())
                    .catch(() => { });
            }
        };
    }, [onScanSuccess]);

    return (
        <div className="relative flex flex-col items-center p-4 bg-gray-900 rounded-lg w-full max-w-sm mx-auto shadow-2xl border border-gray-800">
            {/* Header */}
            <div className="flex justify-between items-center w-full mb-4 px-2">
                <h3 className="text-white font-semibold flex items-center gap-2 text-lg">
                    <Camera className="w-5 h-5 text-blue-400" />
                    Scan Patient QR
                </h3>
                {onClose && (
                    <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors bg-gray-800 hover:bg-gray-700 p-1 rounded-full">
                        <XCircle className="w-5 h-5" />
                    </button>
                )}
            </div>

            {/* ✅ FIX: Fixed-height container that constrains html5-qrcode's injected elements */}
            <div className="relative w-full rounded-lg overflow-hidden bg-black shadow-inner" style={{ height: '300px' }}>

                {/*
                 * ✅ KEY FIX: These styles collapse the canvas (the second element html5-qrcode injects)
                 * and ensure the video fills the container without doubling.
                 * 
                 * html5-qrcode injects: <video> + <canvas> as siblings.
                 * Without a fixed height on the parent, both render at full natural height → doubled feed.
                 * 
                 * [&>#qr-reader>video]  → make video fill the box
                 * [&>#qr-reader>canvas] → hide the raw canvas layer (it's only for internal decoding)
                 */}
                <div
                    id={scannerRegionId}
                    className="w-full h-full [&>video]:w-full [&>video]:h-full [&>video]:object-cover [&>canvas]:hidden"
                />

                {/* Overlays */}
                {scanState === 'initializing' && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900/90 z-10">
                        <Loader2 className="w-8 h-8 text-blue-500 animate-spin mb-3" />
                        <p className="text-blue-400 text-sm font-medium animate-pulse">Initializing camera...</p>
                    </div>
                )}

                {scanState === 'parsing' && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900/90 z-10 backdrop-blur-sm">
                        <Loader2 className="w-10 h-10 text-blue-400 animate-spin mb-3" />
                        <p className="text-white font-medium">Decrypting patient data...</p>
                    </div>
                )}

                {scanState === 'success' && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center bg-green-900/90 z-10 backdrop-blur-sm">
                        <CheckCircle className="w-12 h-12 text-green-400 mb-3 animate-bounce" />
                        <p className="text-white font-bold text-lg tracking-wide">Success</p>
                    </div>
                )}
            </div>

            {/* Status Message */}
            <div className="w-full mt-4 min-h-[3rem] flex items-center justify-center">
                {scanState === 'error' ? (
                    <div className="flex items-center gap-2 bg-red-900/40 text-red-300 px-4 py-2 rounded-md border border-red-800/50 w-full justify-center">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        <p className="text-sm font-medium text-center">{toastMessage}</p>
                    </div>
                ) : scanState === 'scanning' ? (
                    <p className="text-gray-400 text-sm text-center px-4 animate-pulse">
                        Position the QR code inside the square to scan.
                    </p>
                ) : scanState === 'success' ? (
                    <p className="text-green-400 text-sm font-medium text-center">{toastMessage}</p>
                ) : null}
            </div>
        </div>
    );
}