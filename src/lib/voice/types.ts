// ── Self State ──

export interface SelfState {
  valence: number;     // -1 (negative) to 1 (positive)
  arousal: number;     // 0 (calm) to 1 (excited)
  confidence: number;  // 0 (uncertain) to 1 (certain)
  energy: number;      // 0 (depleted) to 1 (full)
  social: number;      // 0 (withdrawn) to 1 (engaged)
  curiosity: number;   // 0 (bored) to 1 (fascinated)
}

export type SelfStateDimension = keyof SelfState;
