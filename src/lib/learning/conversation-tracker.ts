/**
 * Conversation Tracker — In-memory state for the growth engine.
 * Mirrors alive-intelligence-v3/src/core/engines/thalamus/growth-engine.ts:13-20,30-70
 *
 * Tracks exchanges, emotional peaks, and timing per user to determine
 * when a conversation has ended and growth reflection should trigger.
 */

interface ConversationState {
  exchanges: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>;
  startValence: number;
  emotionalPeaks: string[];
  lastExchangeTime: number;
  lastReflectionTime: number;
}

const conversations = new Map<string, ConversationState>();

const IDLE_THRESHOLD = 30_000;     // 30s of idle = conversation end
const REFLECTION_COOLDOWN = 60_000; // 60s between reflections
const MIN_USER_EXCHANGES = 3;       // Need at least 3 user messages

function getState(userId: string): ConversationState {
  let state = conversations.get(userId);
  if (!state) {
    state = {
      exchanges: [],
      startValence: 0.6,
      emotionalPeaks: [],
      lastExchangeTime: 0,
      lastReflectionTime: 0,
    };
    conversations.set(userId, state);
  }
  return state;
}

export function trackExchange(
  userId: string,
  role: 'user' | 'assistant',
  content: string,
  startValence?: number,
): void {
  const state = getState(userId);

  if (state.exchanges.length === 0 && startValence !== undefined) {
    state.startValence = startValence;
  }

  state.exchanges.push({ role, content, timestamp: Date.now() });
  state.lastExchangeTime = Date.now();

  // Keep last 30 exchanges max
  if (state.exchanges.length > 30) {
    state.exchanges = state.exchanges.slice(-30);
  }
}

export function trackEmotionalPeak(userId: string, emotion: string): void {
  const state = getState(userId);
  if (!state.emotionalPeaks.includes(emotion)) {
    state.emotionalPeaks.push(emotion);
  }
  // Keep last 10
  if (state.emotionalPeaks.length > 10) {
    state.emotionalPeaks = state.emotionalPeaks.slice(-10);
  }
}

export function shouldReflect(userId: string): boolean {
  const state = conversations.get(userId);
  if (!state) return false;

  const now = Date.now();
  const userExchanges = state.exchanges.filter(e => e.role === 'user').length;
  const hasEnoughExchanges = userExchanges >= MIN_USER_EXCHANGES;
  const isIdle = state.lastExchangeTime > 0 && (now - state.lastExchangeTime) > IDLE_THRESHOLD;
  const cooldownPassed = (now - state.lastReflectionTime) > REFLECTION_COOLDOWN;

  return hasEnoughExchanges && isIdle && cooldownPassed;
}

/**
 * Check if conversation has enough exchanges for reflection (no idle/cooldown check).
 * Used by the webhook handler which knows the conversation has ended.
 */
export function hasEnoughExchanges(userId: string): boolean {
  const state = conversations.get(userId);
  if (!state) return false;
  return state.exchanges.filter(e => e.role === 'user').length >= MIN_USER_EXCHANGES;
}

export function getConversationData(userId: string): {
  exchanges: Array<{ role: 'user' | 'assistant'; content: string }>;
  trajectory: { start: number; end: number; peaks: string[] };
} | null {
  const state = conversations.get(userId);
  if (!state || state.exchanges.length === 0) return null;

  return {
    exchanges: state.exchanges.slice(-20).map(e => ({
      role: e.role,
      content: e.content,
    })),
    trajectory: {
      start: state.startValence,
      end: state.startValence, // Will be overridden by caller with current valence
      peaks: [...state.emotionalPeaks],
    },
  };
}

export function markReflected(userId: string): void {
  const state = conversations.get(userId);
  if (state) {
    state.lastReflectionTime = Date.now();
  }
}

export function resetConversation(userId: string): void {
  conversations.delete(userId);
}
