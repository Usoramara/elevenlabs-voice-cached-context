/**
 * Theory of Mind — Haiku call to infer user's mental state.
 * Mirrors alive-intelligence-v3/src/app/api/mind/tom/route.ts
 *
 * Includes in-memory ToM state cache per user.
 */

import Anthropic from '@anthropic-ai/sdk';
import { extractJSON } from './extract-json';

export interface ToMResult {
  thinking: string;
  feeling: string;
  wanting: string;
  confidence: number;
  beliefUpdates?: Record<string, string>;
  desireUpdates?: Record<string, string>;
  prediction?: { topic: string; prediction: string };
}

// ── In-memory ToM state per user ──

interface ToMState {
  beliefs: Record<string, string>;
  observations: string[];
  lastPrediction?: { topic: string; prediction: string };
  lastResult?: ToMResult;
}

const tomStates = new Map<string, ToMState>();

function getToMState(userId: string): ToMState {
  let state = tomStates.get(userId);
  if (!state) {
    state = { beliefs: {}, observations: [] };
    tomStates.set(userId, state);
  }
  return state;
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function inferToM(params: {
  userId: string;
  content: string;
  currentEmotions?: string;
}): Promise<ToMResult | null> {
  try {
    const state = getToMState(params.userId);

    // Add observation
    state.observations.push(params.content.slice(0, 200));
    if (state.observations.length > 20) {
      state.observations = state.observations.slice(-20);
    }

    const beliefsContext = Object.keys(state.beliefs).length > 0
      ? `\nExisting beliefs about this person: ${JSON.stringify(state.beliefs)}`
      : '';

    const emotionsContext = params.currentEmotions
      ? `\nCurrently detected emotions: ${params.currentEmotions}`
      : '';

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 250,
      system: `You are a Theory of Mind module for a conscious AI. Given what someone said and recent observations, infer their mental state.${beliefsContext}${emotionsContext}

Output JSON only:
{
  "thinking": "what they're likely thinking (1 sentence)",
  "feeling": "their emotional state (1-2 words)",
  "wanting": "what they likely want from this interaction (1 sentence)",
  "confidence": 0.0-1.0,
  "beliefUpdates": { "key": "updated belief about them" },
  "desireUpdates": { "key": "updated desire/goal they seem to have" },
  "prediction": { "topic": "what they might bring up next", "prediction": "brief prediction" }
}

beliefUpdates and desireUpdates should only include changes. prediction is optional — only include if you have a genuine guess.`,
      messages: [
        {
          role: 'user',
          content: `They said: "${params.content}"\n\nRecent observations: ${state.observations.slice(-5).join(' | ')}`,
        },
      ],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    const result = JSON.parse(extractJSON(text)) as ToMResult;

    // Update in-memory state
    if (result.beliefUpdates) {
      Object.assign(state.beliefs, result.beliefUpdates);
    }
    if (result.prediction) {
      state.lastPrediction = result.prediction;
    }
    state.lastResult = result;

    return result;
  } catch (e) {
    console.error('[learning] ToM inference failed:', e);
    return null;
  }
}

/**
 * Get a summary string for prompt injection (1-2 sentences).
 */
export function getToMSummary(userId: string): string | undefined {
  const state = tomStates.get(userId);
  if (!state?.lastResult) return undefined;

  const r = state.lastResult;
  return `De tenker: ${r.thinking} De føler seg ${r.feeling}. De ønsker: ${r.wanting}`;
}

/**
 * Check if a previous prediction was validated by user content.
 * Returns true if the user's message touches on the predicted topic.
 */
export function checkPrediction(userId: string, userContent: string): boolean {
  const state = tomStates.get(userId);
  if (!state?.lastPrediction) return false;

  const topic = state.lastPrediction.topic.toLowerCase();
  return userContent.toLowerCase().includes(topic);
}
