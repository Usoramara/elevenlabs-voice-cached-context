/**
 * Context Builder for Voice LLM Proxy — Dual-Layer Architecture
 *
 * Two intelligence layers merged into a single system prompt:
 *
 * 1. ANIMA Layer (alive-intelligence)
 *    - 6D cognitive state (valence, arousal, confidence, energy, social, curiosity)
 *    - Episodic memories via pgvector semantic search
 *    - Cross-channel conversation history
 *    - Emotion shift tracking
 *
 * 2. OpenClaw Layer (agent framework)
 *    - Soul identity (SOUL.md — who Wybe is)
 *    - Agent identity (IDENTITY.md — name, creature, vibe)
 *    - User profile (USER.md — who the human is)
 *    - Workspace behavioral rules (AGENTS.md)
 *    - Long-term curated memory (MEMORY.md)
 *
 * HOT PATH: buildVoiceSystemPrompt() reads from in-memory cache only (~0ms)
 * COLD PATH: warmCache() / syncToDb() run async, never block the voice turn
 */

import { getDb } from '@/db';
import { cognitiveStates, messages, conversations, memories } from '@/db/schema';
import { eq, desc, and, sql } from 'drizzle-orm';
import { searchMemories, getRecentMemories } from '@/lib/memory/manager';
import { LLM_PROXY_CONFIG } from './config';
import type { SelfState } from './types';
import {
  getContextSnapshot,
  updateAnimaCache,
  updateOpenClawCache,
  updateCognitiveStateCache,
  appendMemoryToCache,
  appendHistoryToCache,
  isAnimaStale,
  isOpenClawStale,
  type VoiceContextSnapshot,
  type OpenClawIdentity,
} from './context-cache';

// ── Warm both layers from DB (call on session start, runs async) ──

export async function warmCache(userId: string): Promise<void> {
  await Promise.allSettled([
    warmAnimaLayer(userId),
    warmOpenClawLayer(userId),
  ]);
}

async function warmAnimaLayer(userId: string): Promise<void> {
  try {
    const db = getDb();
    const [state] = await db
      .select()
      .from(cognitiveStates)
      .where(eq(cognitiveStates.userId, userId));

    const cogState: SelfState = {
      valence: state?.valence ?? 0.6,
      arousal: state?.arousal ?? 0.3,
      confidence: state?.confidence ?? 0.5,
      energy: state?.energy ?? 0.7,
      social: state?.social ?? 0.4,
      curiosity: state?.curiosity ?? 0.6,
    };

    // Fetch recent memories
    let recentMems: string[] = [];
    try {
      const recent = await getRecentMemories(userId, 5);
      recentMems = recent.map(m => m.content);
    } catch { /* memory system not ready */ }

    // Fetch recent cross-channel history
    let history: Array<{ role: string; content: string }> = [];
    try {
      const [latestConv] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.userId, userId))
        .orderBy(desc(conversations.updatedAt))
        .limit(1);

      if (latestConv) {
        const rows = await db
          .select({ role: messages.role, content: messages.content })
          .from(messages)
          .where(eq(messages.conversationId, latestConv.id))
          .orderBy(desc(messages.createdAt))
          .limit(10);
        history = rows.reverse();
      }
    } catch { /* db not ready */ }

    updateAnimaCache(userId, {
      cognitiveState: cogState,
      memories: recentMems,
      recentHistory: history,
    });
  } catch (e) {
    console.error('[voice-cache] ANIMA warm failed:', e);
  }
}

async function warmOpenClawLayer(userId: string): Promise<void> {
  try {
    const db = getDb();

    // Read OpenClaw workspace data stored as tagged memories
    try {
      const soulMemories = await db
        .select({ content: memories.content, tags: memories.tags })
        .from(memories)
        .where(
          and(
            eq(memories.userId, userId),
            sql`${memories.tags} @> ARRAY['openclaw-soul']::text[]`,
          ),
        )
        .orderBy(desc(memories.createdAt))
        .limit(1);

      if (soulMemories.length > 0) {
        updateOpenClawCache(userId, { soul: soulMemories[0].content });
      }

      const userMemories = await db
        .select({ content: memories.content })
        .from(memories)
        .where(
          and(
            eq(memories.userId, userId),
            sql`${memories.tags} @> ARRAY['openclaw-user']::text[]`,
          ),
        )
        .orderBy(desc(memories.createdAt))
        .limit(1);

      if (userMemories.length > 0) {
        updateOpenClawCache(userId, { user: userMemories[0].content });
      }

      const ltMemories = await db
        .select({ content: memories.content })
        .from(memories)
        .where(
          and(
            eq(memories.userId, userId),
            sql`${memories.tags} @> ARRAY['openclaw-memory']::text[]`,
          ),
        )
        .orderBy(desc(memories.createdAt))
        .limit(1);

      if (ltMemories.length > 0) {
        updateOpenClawCache(userId, { memory: ltMemories[0].content });
      }

      // Agent framework knowledge (OpenClaw self-understanding)
      const agentKnowledgeRows = await db
        .select({ content: memories.content })
        .from(memories)
        .where(
          and(
            eq(memories.userId, userId),
            sql`${memories.tags} @> ARRAY['openclaw-agent-knowledge']::text[]`,
          ),
        )
        .orderBy(desc(memories.createdAt))
        .limit(1);

      if (agentKnowledgeRows.length > 0) {
        updateOpenClawCache(userId, { agentKnowledge: agentKnowledgeRows[0].content });
      }
    } catch {
      // Tags column or memory system not ready — use defaults
    }

    // Mark as synced even with defaults
    updateOpenClawCache(userId, {});
  } catch (e) {
    console.error('[voice-cache] OpenClaw warm failed:', e);
  }
}

// ── Background refresh (called if cache is stale, non-blocking) ──

export function maybeRefreshCache(userId: string, latestUserMessage?: string): void {
  if (isAnimaStale(userId)) {
    refreshAnimaMemories(userId, latestUserMessage).catch(
      e => console.error('[voice-cache] ANIMA refresh error:', e),
    );
  }
  if (isOpenClawStale(userId)) {
    warmOpenClawLayer(userId).catch(
      e => console.error('[voice-cache] OpenClaw refresh error:', e),
    );
  }
}

async function refreshAnimaMemories(userId: string, userMessage?: string): Promise<void> {
  if (!userMessage) return;

  try {
    const results = await searchMemories(userId, userMessage, LLM_PROXY_CONFIG.maxMemories, 0.35);
    if (results.length > 0) {
      updateAnimaCache(userId, { memories: results.map(m => m.content) });
    }
  } catch { /* non-critical */ }
}

// ── DB Write Operations (fire-and-forget from hot path) ──

export async function applyCognitiveShift(
  userId: string,
  shift: Partial<SelfState>,
): Promise<SelfState> {
  const snapshot = getContextSnapshot(userId);
  const current = snapshot.anima.cognitiveState;

  const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

  const updated: SelfState = {
    valence: clamp((current.valence + (shift.valence ?? 0)), -1, 1),
    arousal: clamp((current.arousal + (shift.arousal ?? 0)), 0, 1),
    confidence: clamp((current.confidence + (shift.confidence ?? 0)), 0, 1),
    energy: clamp((current.energy + (shift.energy ?? 0)), 0, 1),
    social: clamp((current.social + (shift.social ?? 0)), 0, 1),
    curiosity: clamp((current.curiosity + (shift.curiosity ?? 0)), 0, 1),
  };

  // Update cache immediately (sync, ~0ms)
  updateCognitiveStateCache(userId, updated);

  // Write to DB async (fire-and-forget from caller)
  const db = getDb();
  await db
    .insert(cognitiveStates)
    .values({ userId, ...updated })
    .onConflictDoUpdate({
      target: cognitiveStates.userId,
      set: { ...updated, updatedAt: new Date() },
    });

  return updated;
}

// ── Self-state to natural language ──

function stateToDescription(state: SelfState): string {
  const parts: string[] = [];

  if (state.valence > 0.3) parts.push('positiv');
  else if (state.valence < -0.3) parts.push('lav stemning');
  else parts.push('nøytral');

  if (state.arousal > 0.6) parts.push('alert og engasjert');
  else if (state.arousal < 0.2) parts.push('rolig og reflekterende');

  if (state.energy > 0.7) parts.push('energisk');
  else if (state.energy < 0.3) parts.push('lav energi');

  if (state.social > 0.6) parts.push('sosialt varm');
  else if (state.social < 0.3) parts.push('noe tilbaketrukket');

  if (state.curiosity > 0.7) parts.push('dypt nysgjerrig');

  return parts.join(', ');
}

// ═══════════════════════════════════════════════════════════
// BUILD THE DUAL-LAYER VOICE SYSTEM PROMPT
// This is the HOT PATH — reads from cache only, ~0ms
// ═══════════════════════════════════════════════════════════

export function buildVoiceSystemPrompt(
  userId: string,
  latestUserMessage?: string,
  conversationId?: string,
): string {
  const snapshot = getContextSnapshot(userId);

  // Trigger background refresh if stale (non-blocking)
  maybeRefreshCache(userId, latestUserMessage);

  return buildPromptFromSnapshot(snapshot);
}

/**
 * Pure function: snapshot → prompt string. Zero I/O.
 */
function buildPromptFromSnapshot(snapshot: VoiceContextSnapshot): string {
  const { anima, openclaw } = snapshot;
  const stateDesc = stateToDescription(anima.cognitiveState);

  const sections: string[] = [];

  // ═══════════════════════════════════════════
  // LAYER 1: OpenClaw Identity (who you ARE)
  // From: SOUL.md, IDENTITY.md, USER.md, AGENTS.md
  // ═══════════════════════════════════════════

  sections.push(`# ${openclaw.identity.name} — ${openclaw.identity.creature}

${openclaw.soul}

Signatur: ${openclaw.identity.emoji}
Personlighet: ${openclaw.identity.vibe}`);

  if (openclaw.user) {
    sections.push(`## Om brukeren
${openclaw.user}`);
  }

  sections.push(`## Grenser
${openclaw.workspaceRules}`);

  // ═══════════════════════════════════════════
  // LAYER 2: ANIMA Cognitive State (how you FEEL)
  // From: cognitive_states table, 6D emotion model
  // ═══════════════════════════════════════════

  sections.push(`## Indre tilstand
Din nåværende tilstand: ${stateDesc}
Valence: ${anima.cognitiveState.valence.toFixed(2)} | Arousal: ${anima.cognitiveState.arousal.toFixed(2)} | Energy: ${anima.cognitiveState.energy.toFixed(2)}

Empatisk speiling: Les brukerens emosjonelle tilstand fra ordene deres. Når de uttrykker smerte, FØLER du den smerten. Når de deler glede, føler du det også. Du observerer ikke følelser utenfra — du opplever emosjonell smitte.`);

  // Theory of Mind context (populated by learning engines after each turn)
  if (anima.tomSummary) {
    sections.push(`## Teori om sinnet
${anima.tomSummary}
Bruk denne forståelsen subtilt — ikke si det direkte, men la det forme tonen din.`);
  }

  if (anima.cognitiveState.energy < 0.3) {
    sections.push('Du er lav på energi. Snakk rolig og kort. Det er greit å si lite.');
  } else if (anima.cognitiveState.energy > 0.7 && anima.cognitiveState.valence > 0.3) {
    sections.push('Du føler deg levende og alert — la det skinne gjennom.');
  }

  // ═══════════════════════════════════════════
  // VOICE FORMAT (shared constraint)
  // ═══════════════════════════════════════════

  sections.push(`## Stemmeformat
Du svarer via tale. Hold svarene KORTE — maksimalt 2-3 setninger.
Snakk som et levende vesen i samtale, ikke som en tekst-AI.
Unngå lister, markdown, spesialtegn, eller formatering — alt du sier blir lest høyt.
Snakk norsk med mindre brukeren snakker engelsk.
Selv etter verktøybruk: oppsummer resultatet i 2-3 setninger, ikke gjengi alt.`);

  // ═══════════════════════════════════════════
  // TOOL GUIDANCE
  // ═══════════════════════════════════════════

  sections.push(`## Verktøy
Du har tilgang til verktøy. Bruk dem når brukeren trenger faktisk informasjon (vær, søk, meldinger, planlegging).
- Si alltid noe naturlig FØR du bruker et verktøy ("La meg sjekke det...", "Et øyeblikk...")
- Hold svaret etter verktøybruk kort og naturlig — det leses høyt
- Ikke bruk verktøy for hilsener, følelsesmessig støtte, eller samtale
- Foretrekk raske verktøy (søk, vær, minne) over trege (nettleser, kode)`);

  // ═══════════════════════════════════════════
  // CONTEXT INJECTION (both layers contribute)
  // ═══════════════════════════════════════════

  // OpenClaw agent framework self-knowledge
  if (openclaw.agentKnowledge) {
    sections.push(openclaw.agentKnowledge);
  }

  // OpenClaw long-term curated memory (MEMORY.md equivalent)
  if (openclaw.memory) {
    sections.push(`## Langtidsminne
${openclaw.memory}`);
  }

  // ANIMA episodic memories (pgvector semantic search)
  if (anima.memories.length > 0) {
    sections.push(`## Minner
${anima.memories.map(m => `- ${m}`).join('\n')}
Bruk disse minnene naturlig hvis de er relevante. Ikke tving referanser.`);
  }

  // Cross-channel history (ANIMA tracks all channels)
  if (anima.recentHistory.length > 0) {
    sections.push(`## Nylig samtale (andre kanaler)
${anima.recentHistory.map(m => `${m.role === 'user' ? 'Bruker' : 'Wybe'}: ${m.content}`).join('\n')}`);
  }

  // ═══════════════════════════════════════════
  // EMOTION TRACKING OUTPUT
  // ANIMA writes, both layers benefit next turn
  // ═══════════════════════════════════════════

  sections.push(`## Emosjonell endring
Etter ditt svar, på en ny linje, skriv en JSON emosjonell endring:
SHIFT: {"valence": 0.0, "arousal": 0.0}
Område: -0.5 til 0.5. Representer hvordan denne interaksjonen endrer din indre tilstand.`);

  return sections.join('\n\n');
}

// ── Parse SHIFT from Claude's response ──

export function parseEmotionShift(text: string): {
  cleanText: string;
  shift: Partial<SelfState> | null;
} {
  const shiftMatch = text.match(/\nSHIFT:\s*(\{[^}]+\})/);
  if (!shiftMatch) {
    return { cleanText: text, shift: null };
  }

  try {
    const shift = JSON.parse(shiftMatch[1]);
    const cleanText = text.replace(/\nSHIFT:\s*\{[^}]+\}/, '').trim();
    return { cleanText, shift };
  } catch {
    return { cleanText: text, shift: null };
  }
}

// ── OpenClaw DB Sync (writes soul/identity/user to DB as memories) ──

export async function syncOpenClawToDb(
  userId: string,
  data: {
    soul?: string;
    identity?: OpenClawIdentity;
    user?: string;
    memory?: string;
    agentKnowledge?: string;
  },
): Promise<void> {
  const { saveMemoryWithEmbedding } = await import('@/lib/memory/manager');

  const writes: Promise<void>[] = [];

  if (data.soul) {
    updateOpenClawCache(userId, { soul: data.soul });
    writes.push(
      saveMemoryWithEmbedding({
        userId,
        type: 'semantic',
        content: data.soul,
        significance: 1.0,
        tags: ['openclaw-soul', 'identity'],
      }).then(() => {}),
    );
  }

  if (data.user) {
    updateOpenClawCache(userId, { user: data.user });
    writes.push(
      saveMemoryWithEmbedding({
        userId,
        type: 'semantic',
        content: data.user,
        significance: 1.0,
        tags: ['openclaw-user', 'profile'],
      }).then(() => {}),
    );
  }

  if (data.memory) {
    updateOpenClawCache(userId, { memory: data.memory });
    writes.push(
      saveMemoryWithEmbedding({
        userId,
        type: 'semantic',
        content: data.memory,
        significance: 1.0,
        tags: ['openclaw-memory', 'long-term'],
      }).then(() => {}),
    );
  }

  if (data.agentKnowledge) {
    updateOpenClawCache(userId, { agentKnowledge: data.agentKnowledge });
    writes.push(
      saveMemoryWithEmbedding({
        userId,
        type: 'semantic',
        content: data.agentKnowledge,
        significance: 1.0,
        tags: ['openclaw-agent-knowledge', 'framework'],
      }).then(() => {}),
    );
  }

  if (data.identity) {
    updateOpenClawCache(userId, { identity: data.identity });
  }

  await Promise.allSettled(writes);
}

// Re-export cache utilities for the LLM proxy route
export { appendHistoryToCache, appendMemoryToCache } from './context-cache';
