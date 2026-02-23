'use client';

import { useConversation, type DisconnectionDetails } from '@elevenlabs/react';
import { useState, useCallback, useRef, useEffect } from 'react';

interface CognitiveState {
  valence: number;
  arousal: number;
  energy: number;
}

interface TranscriptEntry {
  role: 'user' | 'agent';
  message: string;
}

const DEFAULT_STATE: CognitiveState = { valence: 0.6, arousal: 0.3, energy: 0.5 };
const MAX_RECONNECT_ATTEMPTS = 3;

/** Map valence (-1..1) to a hue: red(0) → yellow(60) → green(120) → cyan(180) */
function valenceToHue(v: number): number {
  return Math.round(((v + 1) / 2) * 180);
}

export default function VoiceInterface() {
  const [cogState, setCogState] = useState<CognitiveState>(DEFAULT_STATE);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const intentionalDisconnect = useRef(false);
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const conversation = useConversation({
    onMessage: ({ message, role }) => {
      setTranscript((prev) => [...prev, { role, message }]);
    },
    onConnect: () => {
      setError(null);
      setIsReconnecting(false);
      reconnectAttempts.current = 0;
    },
    onDisconnect: (details: DisconnectionDetails) => {
      console.log('[voice] Disconnected:', details.reason);
      fetchCognitiveState();

      // Auto-reconnect on non-user disconnects
      if (
        !intentionalDisconnect.current &&
        details.reason !== 'user' &&
        reconnectAttempts.current < MAX_RECONNECT_ATTEMPTS
      ) {
        const delay = Math.min(1000 * 2 ** reconnectAttempts.current, 8000);
        console.log(`[voice] Auto-reconnect attempt ${reconnectAttempts.current + 1}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);
        setIsReconnecting(true);
        reconnectTimer.current = setTimeout(() => {
          handleReconnect();
        }, delay);
      }
    },
    onError: (message) => {
      console.error('[voice] Error:', message);
      setError(message);
    },
  });

  // Cleanup reconnect timer on unmount
  useEffect(() => {
    return () => {
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
      }
    };
  }, []);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [transcript]);

  const fetchCognitiveState = useCallback(async () => {
    try {
      const res = await fetch('/api/voice/openclaw');
      if (res.ok) {
        const data = await res.json();
        if (data.anima?.cognitiveState) {
          setCogState(data.anima.cognitiveState);
        }
      }
    } catch {
      // Non-critical — keep last known state
    }
  }, []);

  const handleReconnect = useCallback(async () => {
    try {
      reconnectAttempts.current += 1;

      // Get fresh signed URL
      const urlRes = await fetch('/api/voice/signed-url');
      const { signedUrl } = await urlRes.json();

      if (!signedUrl) {
        console.error('[voice] Reconnect failed: no signed URL');
        setIsReconnecting(false);
        setError('Reconnect failed — tap to restart');
        return;
      }

      // Re-init session for fresh context
      const sessionRes = await fetch('/api/voice/session', { method: 'POST' });
      const session = await sessionRes.json();

      await conversation.startSession({
        signedUrl,
        dynamicVariables: session.dynamicVariables,
      });
    } catch (err) {
      console.error('[voice] Reconnect failed:', err);
      if (reconnectAttempts.current >= MAX_RECONNECT_ATTEMPTS) {
        setIsReconnecting(false);
        setError('Connection lost — tap to restart');
      }
    }
  }, [conversation]);

  const handleStart = useCallback(async () => {
    try {
      setError(null);
      setTranscript([]);
      intentionalDisconnect.current = false;
      reconnectAttempts.current = 0;

      // Request mic permission
      await navigator.mediaDevices.getUserMedia({ audio: true });

      // Warm cache via session init
      const sessionRes = await fetch('/api/voice/session', { method: 'POST' });
      const session = await sessionRes.json();

      if (session.dynamicVariables) {
        setCogState({
          valence: parseFloat(session.dynamicVariables.valence) || DEFAULT_STATE.valence,
          arousal: parseFloat(session.dynamicVariables.arousal) || DEFAULT_STATE.arousal,
          energy: parseFloat(session.dynamicVariables.energy) || DEFAULT_STATE.energy,
        });
      }

      // Get signed URL
      const urlRes = await fetch('/api/voice/signed-url');
      const { signedUrl } = await urlRes.json();

      if (!signedUrl) {
        setError('Could not get signed URL');
        return;
      }

      // Start ElevenLabs session
      await conversation.startSession({
        signedUrl,
        dynamicVariables: session.dynamicVariables,
      });
    } catch (err) {
      console.error('[voice] Start failed:', err);
      setError(err instanceof Error ? err.message : 'Failed to start');
    }
  }, [conversation, fetchCognitiveState]);

  const handleEnd = useCallback(async () => {
    intentionalDisconnect.current = true;
    if (reconnectTimer.current) {
      clearTimeout(reconnectTimer.current);
      reconnectTimer.current = null;
    }
    setIsReconnecting(false);
    await conversation.endSession();
  }, [conversation]);

  const isActive = conversation.status === 'connected';
  const isConnecting = conversation.status === 'connecting';

  // Orb visual properties from cognitive state
  const hue = valenceToHue(cogState.valence);
  const pulseSpeed = 1 + cogState.arousal * 2; // 1-3s
  const orbSize = 120 + cogState.energy * 80; // 120-200px

  return (
    <div style={styles.container}>
      {/* Orb */}
      <button
        onClick={isActive ? handleEnd : handleStart}
        disabled={isConnecting || isReconnecting}
        style={{
          ...styles.orbButton,
          width: orbSize,
          height: orbSize,
        }}
        aria-label={isActive ? 'End conversation' : 'Start conversation'}
      >
        <div
          style={{
            ...styles.orb,
            width: '100%',
            height: '100%',
            background: `radial-gradient(circle at 40% 40%, hsl(${hue}, 80%, 65%), hsl(${hue}, 60%, 30%))`,
            boxShadow: isActive
              ? `0 0 ${40 + cogState.arousal * 40}px hsl(${hue}, 70%, 50%)`
              : `0 0 20px hsl(${hue}, 40%, 30%)`,
            animation: isActive
              ? `pulse ${pulseSpeed}s ease-in-out infinite`
              : 'none',
          }}
        />
      </button>

      {/* Status */}
      <div style={styles.status}>
        {isConnecting && 'Connecting...'}
        {isReconnecting && 'Reconnecting...'}
        {isActive && conversation.isSpeaking && 'Speaking...'}
        {isActive && !conversation.isSpeaking && 'Listening...'}
        {!isActive && !isConnecting && !isReconnecting && 'Tap to speak'}
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {/* Transcript */}
      {transcript.length > 0 && (
        <div style={styles.transcript}>
          {transcript.map((entry, i) => (
            <div
              key={i}
              style={{
                ...styles.message,
                textAlign: entry.role === 'user' ? 'right' : 'left',
                opacity: entry.role === 'user' ? 0.7 : 1,
              }}
            >
              <span style={styles.role}>
                {entry.role === 'user' ? 'Du' : 'Wybe'}
              </span>
              <p style={styles.text}>{entry.message}</p>
            </div>
          ))}
          <div ref={transcriptEndRef} />
        </div>
      )}

      {/* Pulse animation */}
      <style>{`
        @keyframes pulse {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.08); }
        }
      `}</style>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100dvh',
    padding: '2rem',
    gap: '1.5rem',
    background: '#0a0a0a',
    color: '#e0e0e0',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  orbButton: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    borderRadius: '50%',
    transition: 'transform 0.2s',
  },
  orb: {
    borderRadius: '50%',
    transition: 'box-shadow 0.5s, background 0.5s',
  },
  status: {
    fontSize: '0.9rem',
    color: '#888',
    letterSpacing: '0.05em',
    textTransform: 'uppercase' as const,
  },
  error: {
    fontSize: '0.85rem',
    color: '#ff6b6b',
    maxWidth: 400,
    textAlign: 'center' as const,
  },
  transcript: {
    width: '100%',
    maxWidth: 480,
    maxHeight: '40vh',
    overflowY: 'auto' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.75rem',
    padding: '1rem 0',
  },
  message: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '0.2rem',
  },
  role: {
    fontSize: '0.7rem',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.1em',
    color: '#666',
  },
  text: {
    margin: 0,
    fontSize: '0.95rem',
    lineHeight: 1.5,
  },
};
