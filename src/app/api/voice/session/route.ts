/**
 * Voice Session Initialization — Warms Both Intelligence Layers
 *
 * Called by the client before starting a voice session.
 * Triggers async cache warm for both ANIMA and OpenClaw layers
 * so the first voice turn reads from a hot cache.
 *
 * Returns ElevenLabs SDK configuration with current cognitive state.
 */

import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { conversations } from '@/db/schema';
import { warmCache } from '@/lib/voice/context-builder';
import { getContextSnapshot } from '@/lib/voice/context-cache';
import { resolveVoiceUserId } from '@/lib/voice/resolve-user';

const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;

export async function POST(): Promise<Response> {
  const userId = await resolveVoiceUserId();

  // ── Warm both layers (ANIMA + OpenClaw) in parallel ──
  // This runs async but we await it here since this is session init,
  // not the hot voice-turn path. ~50-100ms is fine at session start.
  await warmCache(userId);

  // Read from the now-warm cache
  const snapshot = getContextSnapshot(userId);

  // Create voice conversation in DB
  const db = getDb();
  const [conv] = await db
    .insert(conversations)
    .values({ userId, title: '🎙️ Voice' })
    .returning({ id: conversations.id });

  return NextResponse.json({
    ok: true,
    agentId: ELEVENLABS_AGENT_ID,
    conversationId: conv.id,
    // Dynamic variables for ElevenLabs agent
    dynamicVariables: {
      user_id: userId,
      conversation_id: conv.id,
      // ANIMA layer state
      valence: snapshot.anima.cognitiveState.valence.toFixed(2),
      arousal: snapshot.anima.cognitiveState.arousal.toFixed(2),
      energy: snapshot.anima.cognitiveState.energy.toFixed(2),
      // OpenClaw layer identity
      agent_name: snapshot.openclaw.identity.name,
      agent_vibe: snapshot.openclaw.identity.vibe,
    },
    // Cache health
    cache: {
      animaSynced: snapshot.anima.lastSynced > 0,
      openclawSynced: snapshot.openclaw.lastSynced > 0,
      memories: snapshot.anima.memories.length,
      history: snapshot.anima.recentHistory.length,
    },
  });
}
