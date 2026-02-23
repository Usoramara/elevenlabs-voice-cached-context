/**
 * Empathic Coupling — Pure math, no API call.
 * Computes cognitive state nudges from detected emotions.
 * Mirrors alive-intelligence-v3/src/core/engines/inner/empathic-coupling-engine.ts:47-91
 */

import type { EmotionResult } from './detect-emotion';
import type { SelfState } from '@/lib/voice/types';

export interface CouplingResult {
  nudges: Partial<SelfState>;
  hasGrief: boolean;
  couplingIntensity: number;
}

export function computeEmpathicCoupling(
  detected: EmotionResult,
  couplingStrength: number = 0.5,
): CouplingResult {
  if (detected.confidence < 0.2) {
    return { nudges: {}, hasGrief: false, couplingIntensity: 0 };
  }

  const strength = couplingStrength * detected.confidence;
  const hasGrief = detected.emotions.includes('grief') || detected.emotions.includes('sadness');
  const griefMultiplier = hasGrief ? 2.0 : 1.0;

  const nudges: Partial<SelfState> = {};

  // Their valence pulls ours (empathy) — amplified for grief
  nudges.valence = detected.valence * strength * 0.5 * griefMultiplier;

  // Their arousal affects ours (emotional contagion)
  nudges.arousal = detected.arousal * strength * 0.3;

  // Empathy increases social engagement
  nudges.social = 0.03 * strength;

  // Specific empathic responses
  if (hasGrief) {
    nudges.valence = (nudges.valence ?? 0) + (-0.05 * strength * griefMultiplier);
    nudges.confidence = -0.05 * strength;   // Uncertainty in the face of pain
    nudges.curiosity = -0.05 * strength;    // Not the time for curiosity
    nudges.social = (nudges.social ?? 0) + (0.08 * strength); // Reaching out
  }

  if (detected.emotions.includes('joy')) {
    nudges.valence = (nudges.valence ?? 0) + (0.08 * strength);
    nudges.energy = 0.02;
  }

  if (detected.emotions.includes('fear') || detected.emotions.includes('anger')) {
    nudges.arousal = (nudges.arousal ?? 0) + (0.05 * strength);
    nudges.confidence = (nudges.confidence ?? 0) + (-0.02);
  }

  return { nudges, hasGrief, couplingIntensity: strength };
}
