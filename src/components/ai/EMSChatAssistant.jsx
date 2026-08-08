/**
 * EMSChatAssistant.jsx — Floating AI Copilot Chat Widget
 * 
 * Role-aware chat UI powered by GPT-5 mini.
 * Features:
 * - Floating toggle button (bottom-right)
 * - Role badge display
 * - Suggested prompt chips
 * - Context chips (Case ID / Hospital)
 * - Scrollable chat history with auto-scroll
 * - Simple markdown rendering
 * - Loading states and error handling
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useAuth } from '../auth/AuthProvider.jsx';
import { sendChatMessage, checkGeminiHealth } from '../../services/geminiService.js';

// ═══════════════════════════════════════════════════════════════
// ROLE CONFIG
// ═══════════════════════════════════════════════════════════════

const ROLE_CONFIG = {
    paramedic: {
        label: 'Paramedic',
        icon: '🚑',
        color: '#ef4444',
        gradient: 'from-red-500 to-red-700',
        description: 'Triage & routing advice'
    },
    dispatcher: {
        label: 'Dispatcher',
        icon: '📡',
        color: '#3b82f6',
        gradient: 'from-blue-500 to-blue-700',
        description: 'Fleet & case management'
    },
    hospital_admin: {
        label: 'Hospital Admin',
        icon: '🏥',
        color: '#10b981',
        gradient: 'from-emerald-500 to-emerald-700',
        description: 'Capacity & operations'
    },
    command_center: {
        label: 'Command Center',
        icon: '🎯',
        color: '#8b5cf6',
        gradient: 'from-violet-500 to-violet-700',
        description: 'System-wide intelligence'
    },
    admin: {
        label: 'Admin',
        icon: '⚙️',
        color: '#f59e0b',
        gradient: 'from-amber-500 to-amber-700',
        description: 'Platform management'
    }
};

const DEFAULT_PROMPTS = {
    paramedic: [
        "Which hospital is best for my patient?",
        "What's the golden hour status?",
        "Are ventilators available nearby?",
        "Explain the hospital ranking"
    ],
    dispatcher: [
        "Show fleet utilization",
        "Any overloaded zones?",
        "Which hospitals are near capacity?",
        "Recommend next assignment"
    ],
    hospital_admin: [
        "Current bed availability?",
        "Any incoming cases?",
        "Specialist availability summary",
        "What's our capability score?"
    ],
    command_center: [
        "System-wide status summary",
        "Any golden hour violations?",
        "Network bottlenecks?",
        "Fleet distribution overview"
    ],
    admin: [
        "System analytics overview",
        "Scoring engine config?",
        "Platform health check",
        "Hospital network coverage"
    ]
};

// ═══════════════════════════════════════════════════════════════
// SIMPLE MARKDOWN RENDERER
// ═══════════════════════════════════════════════════════════════

function renderMarkdown(text) {
    if (!text) return '';

    return text
        // Bold
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        // Italic
        .replace(/\*(.*?)\*/g, '<em>$1</em>')
        // Inline code
        .replace(/`([^`]+)`/g, '<code style="background:#1e293b;padding:2px 6px;border-radius:4px;font-size:0.85em;color:#e2e8f0">$1</code>')
        // Bullet points
        .replace(/^[-•]\s+(.+)/gm, '<div style="display:flex;gap:8px;margin:2px 0"><span style="color:#94a3b8">•</span><span>$1</span></div>')
        // Numbered lists
        .replace(/^(\d+)\.\s+(.+)/gm, '<div style="display:flex;gap:8px;margin:2px 0"><span style="color:#94a3b8;font-weight:600">$1.</span><span>$2</span></div>')
        // Line breaks
        .replace(/\n/g, '<br/>');
}

// ═══════════════════════════════════════════════════════════════
// CHAT COMPONENT
// ═══════════════════════════════════════════════════════════════

export default function EMSChatAssistant() {
    const { currentUser, role } = useAuth();
    const [isOpen, setIsOpen] = useState(false);
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [isHealthy, setIsHealthy] = useState(null);
    const [contextIds, setContextIds] = useState({});
    const [sessionId] = useState(() => `session_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    const [suggestedPrompts, setSuggestedPrompts] = useState([]);

    const messagesEndRef = useRef(null);
    const inputRef = useRef(null);

    const roleConfig = ROLE_CONFIG[role] || ROLE_CONFIG.paramedic;

    // ─── Health Check on Open ─────────────────────────────────
    useEffect(() => {
        if (isOpen && isHealthy === null) {
            checkGeminiHealth().then(setIsHealthy);
        }
    }, [isOpen, isHealthy]);

    // ─── Set Default Prompts ──────────────────────────────────
    useEffect(() => {
        setSuggestedPrompts(DEFAULT_PROMPTS[role] || DEFAULT_PROMPTS.paramedic);
    }, [role]);

    // ─── Auto-scroll to Bottom ────────────────────────────────
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // ─── Focus Input on Open ──────────────────────────────────
    useEffect(() => {
        if (isOpen) {
            setTimeout(() => inputRef.current?.focus(), 300);
        }
    }, [isOpen]);

    // ─── Send Message ─────────────────────────────────────────
    const handleSend = useCallback(async (messageText) => {
        const text = (messageText || input).trim();
        if (!text || isLoading) return;

        // Add user message
        setMessages(prev => [...prev, { role: 'user', text, timestamp: Date.now() }]);
        setInput('');
        setIsLoading(true);

        try {
            const response = await sendChatMessage({
                message: text,
                role: role || 'paramedic',
                contextIds,
                sessionId
            });

            // Add AI response
            setMessages(prev => [...prev, {
                role: 'assistant',
                text: response.reply,
                timestamp: Date.now(),
                contextUsed: response.contextUsed
            }]);

            // Update suggested prompts from response
            if (response.suggestedFollowups?.length > 0) {
                setSuggestedPrompts(response.suggestedFollowups);
            }
        } catch (err) {
            setMessages(prev => [...prev, {
                role: 'error',
                text: `Failed to get response: ${err.message}`,
                timestamp: Date.now()
            }]);
        } finally {
            setIsLoading(false);
        }
    }, [input, isLoading, role, contextIds, sessionId]);

    // ─── Key Handler ──────────────────────────────────────────
    const handleKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    // ─── Clear Chat ───────────────────────────────────────────
    const handleClear = () => {
        setMessages([]);
        setSuggestedPrompts(DEFAULT_PROMPTS[role] || DEFAULT_PROMPTS.paramedic);
    };

    // Don't render if not logged in
    if (!currentUser) return null;

    return (
        <>
            {/* ─── Floating Toggle Button ──────────────────────── */}
            <button
                onClick={() => setIsOpen(!isOpen)}
                style={{
                    position: 'fixed',
                    bottom: '24px',
                    right: '24px',
                    width: '60px',
                    height: '60px',
                    borderRadius: '50%',
                    background: `linear-gradient(135deg, ${roleConfig.color}, ${roleConfig.color}dd)`,
                    color: 'white',
                    border: 'none',
                    cursor: 'pointer',
                    boxShadow: '0 8px 32px rgba(0,0,0,0.3), 0 0 0 4px rgba(255,255,255,0.1)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: '28px',
                    zIndex: 9999,
                    transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                    transform: isOpen ? 'rotate(0deg) scale(0.9)' : 'rotate(0deg) scale(1)',
                }}
                title="AI Copilot"
            >
                {isOpen ? '✕' : '🤖'}
            </button>

            {/* ─── Chat Panel ──────────────────────────────────── */}
            {isOpen && (
                <div style={{
                    position: 'fixed',
                    bottom: '96px',
                    right: '24px',
                    width: '420px',
                    maxWidth: 'calc(100vw - 48px)',
                    height: '600px',
                    maxHeight: 'calc(100vh - 140px)',
                    borderRadius: '20px',
                    overflow: 'hidden',
                    boxShadow: '0 25px 60px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.05)',
                    zIndex: 9998,
                    display: 'flex',
                    flexDirection: 'column',
                    background: '#0f172a',
                    animation: 'slideUpFadeIn 0.3s ease-out',
                }}>
                    {/* Header */}
                    <div style={{
                        background: `linear-gradient(135deg, ${roleConfig.color}, ${roleConfig.color}cc)`,
                        padding: '16px 20px',
                        color: 'white',
                        flexShrink: 0,
                    }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                                <span style={{ fontSize: '24px' }}>🤖</span>
                                <div>
                                    <div style={{ fontWeight: 700, fontSize: '15px' }}>MEDROUTER AI Assistant</div>
                                    <div style={{ fontSize: '11px', opacity: 0.85 }}>
                                        {roleConfig.icon} {roleConfig.label} • {roleConfig.description}
                                    </div>
                                </div>
                            </div>
                            <div style={{ display: 'flex', gap: '8px' }}>
                                <button
                                    onClick={handleClear}
                                    style={{
                                        background: 'rgba(255,255,255,0.15)',
                                        border: 'none',
                                        color: 'white',
                                        padding: '4px 10px',
                                        borderRadius: '8px',
                                        fontSize: '11px',
                                        cursor: 'pointer',
                                        transition: 'background 0.2s',
                                    }}
                                    onMouseEnter={e => e.target.style.background = 'rgba(255,255,255,0.25)'}
                                    onMouseLeave={e => e.target.style.background = 'rgba(255,255,255,0.15)'}
                                    title="Clear chat"
                                >
                                    🗑️ Clear
                                </button>
                            </div>
                        </div>

                        {/* Context Chips */}
                        {(contextIds.caseId || contextIds.hospitalId) && (
                            <div style={{ display: 'flex', gap: '6px', marginTop: '8px', flexWrap: 'wrap' }}>
                                {contextIds.caseId && (
                                    <span style={{
                                        background: 'rgba(255,255,255,0.2)',
                                        padding: '2px 8px',
                                        borderRadius: '999px',
                                        fontSize: '10px',
                                        fontWeight: 600,
                                    }}>
                                        📋 Case: {contextIds.caseId.slice(0, 8)}...
                                    </span>
                                )}
                                {contextIds.hospitalId && (
                                    <span style={{
                                        background: 'rgba(255,255,255,0.2)',
                                        padding: '2px 8px',
                                        borderRadius: '999px',
                                        fontSize: '10px',
                                        fontWeight: 600,
                                    }}>
                                        🏥 Hospital: {contextIds.hospitalId.slice(0, 8)}...
                                    </span>
                                )}
                            </div>
                        )}
                    </div>


                    {/* Messages Area */}
                    <div style={{
                        flex: 1,
                        overflowY: 'auto',
                        padding: '16px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '12px',
                    }}>
                        {/* Welcome Message */}
                        {messages.length === 0 && (
                            <div style={{ textAlign: 'center', padding: '20px 10px' }}>
                                <div style={{ fontSize: '40px', marginBottom: '12px' }}>🤖</div>
                                <div style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '15px', marginBottom: '4px' }}>
                                    MEDROUTER AI Assistant
                                </div>
                                <div style={{ color: '#94a3b8', fontSize: '12px', marginBottom: '20px' }}>
                                    Powered by GPT-5 mini • {roleConfig.label} Mode
                                </div>

                                {/* Suggested Prompts */}
                                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                    {suggestedPrompts.map((prompt, i) => (
                                        <button
                                            key={i}
                                            onClick={() => handleSend(prompt)}
                                            disabled={isLoading}
                                            style={{
                                                background: '#1e293b',
                                                border: '1px solid #334155',
                                                color: '#e2e8f0',
                                                padding: '10px 14px',
                                                borderRadius: '12px',
                                                fontSize: '12px',
                                                cursor: isLoading ? 'not-allowed' : 'pointer',
                                                textAlign: 'left',
                                                transition: 'all 0.2s',
                                                opacity: isLoading ? 0.5 : 1,
                                            }}
                                            onMouseEnter={e => {
                                                e.target.style.borderColor = roleConfig.color;
                                                e.target.style.background = '#1e293bcc';
                                            }}
                                            onMouseLeave={e => {
                                                e.target.style.borderColor = '#334155';
                                                e.target.style.background = '#1e293b';
                                            }}
                                        >
                                            💡 {prompt}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Chat Messages */}
                        {messages.map((msg, i) => (
                            <div
                                key={i}
                                style={{
                                    display: 'flex',
                                    justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                                    gap: '8px',
                                }}
                            >
                                {msg.role !== 'user' && (
                                    <div style={{
                                        width: '28px',
                                        height: '28px',
                                        borderRadius: '50%',
                                        background: msg.role === 'error' ? '#7f1d1d' : `linear-gradient(135deg, ${roleConfig.color}, ${roleConfig.color}99)`,
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        fontSize: '14px',
                                        flexShrink: 0,
                                        marginTop: '2px',
                                    }}>
                                        {msg.role === 'error' ? '⚠️' : '🤖'}
                                    </div>
                                )}
                                <div style={{
                                    maxWidth: '85%',
                                    padding: '10px 14px',
                                    borderRadius: msg.role === 'user'
                                        ? '16px 16px 4px 16px'
                                        : '16px 16px 16px 4px',
                                    background: msg.role === 'user'
                                        ? `linear-gradient(135deg, ${roleConfig.color}, ${roleConfig.color}cc)`
                                        : msg.role === 'error'
                                            ? '#7f1d1d'
                                            : '#1e293b',
                                    color: msg.role === 'error' ? '#fca5a5' : '#e2e8f0',
                                    fontSize: '13px',
                                    lineHeight: '1.5',
                                    border: msg.role === 'assistant' ? '1px solid #334155' : 'none',
                                    wordBreak: 'break-word',
                                }}>
                                    {msg.role === 'user' ? (
                                        <span>{msg.text}</span>
                                    ) : (
                                        <div
                                            dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.text) }}
                                        />
                                    )}
                                </div>
                            </div>
                        ))}

                        {/* Loading Indicator */}
                        {isLoading && (
                            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                                <div style={{
                                    width: '28px',
                                    height: '28px',
                                    borderRadius: '50%',
                                    background: `linear-gradient(135deg, ${roleConfig.color}, ${roleConfig.color}99)`,
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: '14px',
                                    flexShrink: 0,
                                }}>
                                    🤖
                                </div>
                                <div style={{
                                    padding: '12px 16px',
                                    borderRadius: '16px 16px 16px 4px',
                                    background: '#1e293b',
                                    border: '1px solid #334155',
                                    display: 'flex',
                                    gap: '4px',
                                    alignItems: 'center',
                                }}>
                                    <div style={{ display: 'flex', gap: '3px' }}>
                                        {[0, 1, 2].map(i => (
                                            <div key={i} style={{
                                                width: '6px',
                                                height: '6px',
                                                borderRadius: '50%',
                                                background: roleConfig.color,
                                                animation: `dotPulse 1.4s infinite ease-in-out`,
                                                animationDelay: `${i * 0.2}s`,
                                            }} />
                                        ))}
                                    </div>
                                    <span style={{ color: '#94a3b8', fontSize: '11px', marginLeft: '8px' }}>
                                        Thinking...
                                    </span>
                                </div>
                            </div>
                        )}

                        {/* Follow-up Prompts (after messages) */}
                        {messages.length > 0 && !isLoading && suggestedPrompts.length > 0 && (
                            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '4px' }}>
                                {suggestedPrompts.slice(0, 3).map((prompt, i) => (
                                    <button
                                        key={i}
                                        onClick={() => handleSend(prompt)}
                                        style={{
                                            background: 'transparent',
                                            border: '1px solid #334155',
                                            color: '#94a3b8',
                                            padding: '6px 10px',
                                            borderRadius: '999px',
                                            fontSize: '11px',
                                            cursor: 'pointer',
                                            transition: 'all 0.2s',
                                            whiteSpace: 'nowrap',
                                        }}
                                        onMouseEnter={e => {
                                            e.target.style.borderColor = roleConfig.color;
                                            e.target.style.color = '#e2e8f0';
                                        }}
                                        onMouseLeave={e => {
                                            e.target.style.borderColor = '#334155';
                                            e.target.style.color = '#94a3b8';
                                        }}
                                    >
                                        {prompt}
                                    </button>
                                ))}
                            </div>
                        )}

                        <div ref={messagesEndRef} />
                    </div>

                    {/* Input Area */}
                    <div style={{
                        padding: '12px 16px',
                        borderTop: '1px solid #1e293b',
                        background: '#0f172a',
                        flexShrink: 0,
                    }}>
                        <div style={{
                            display: 'flex',
                            gap: '8px',
                            alignItems: 'flex-end',
                        }}>
                            <textarea
                                ref={inputRef}
                                value={input}
                                onChange={e => setInput(e.target.value)}
                                onKeyDown={handleKeyDown}
                                placeholder={`Ask your ${roleConfig.label} copilot...`}
                                disabled={isLoading}
                                rows={1}
                                style={{
                                    flex: 1,
                                    background: '#1e293b',
                                    border: '1px solid #334155',
                                    borderRadius: '12px',
                                    padding: '10px 14px',
                                    color: '#e2e8f0',
                                    fontSize: '13px',
                                    resize: 'none',
                                    outline: 'none',
                                    fontFamily: 'inherit',
                                    lineHeight: '1.4',
                                    maxHeight: '80px',
                                    transition: 'border-color 0.2s',
                                }}
                                onFocus={e => e.target.style.borderColor = roleConfig.color}
                                onBlur={e => e.target.style.borderColor = '#334155'}
                            />
                            <button
                                onClick={() => handleSend()}
                                disabled={!input.trim() || isLoading}
                                style={{
                                    width: '40px',
                                    height: '40px',
                                    borderRadius: '12px',
                                    background: (!input.trim() || isLoading)
                                        ? '#334155'
                                        : `linear-gradient(135deg, ${roleConfig.color}, ${roleConfig.color}cc)`,
                                    border: 'none',
                                    color: 'white',
                                    cursor: (!input.trim() || isLoading) ? 'not-allowed' : 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    fontSize: '16px',
                                    flexShrink: 0,
                                    transition: 'all 0.2s',
                                    opacity: (!input.trim() || isLoading) ? 0.5 : 1,
                                }}
                            >
                                ➤
                            </button>
                        </div>
                        <div style={{ color: '#475569', fontSize: '10px', marginTop: '6px', textAlign: 'center' }}>
                            GPT-5 mini • Role: {roleConfig.label} • EMS Decision Intelligence
                        </div>
                    </div>
                </div>
            )}

            {/* ─── Animations CSS ──────────────────────────────── */}
            <style>{`
                @keyframes slideUpFadeIn {
                    from {
                        opacity: 0;
                        transform: translateY(20px) scale(0.95);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0) scale(1);
                    }
                }
                @keyframes dotPulse {
                    0%, 80%, 100% {
                        transform: scale(0.6);
                        opacity: 0.4;
                    }
                    40% {
                        transform: scale(1);
                        opacity: 1;
                    }
                }
            `}</style>
        </>
    );
}
