/**
 * Voice Session Initialization — Warms Both Intelligence Layers
 *
 * Called by the client before starting a voice session.
 * Triggers async cache warm for both ANIMA and OpenClaw layers
 * so the first voice turn reads from a hot cache.
 *
 * Returns cognitive state for the orb visualization.
 * ElevenLabs uses its configured first_message ("Hei.") directly.
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
  await warmCache(userId);

  // Read from the now-warm cache
  const snapshot = getContextSnapshot(userId);
  const cog = snapshot.anima.cognitiveState;

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
    cognitiveState: {
      valence: cog.valence,
      arousal: cog.arousal,
      energy: cog.energy,
    },
    cache: {
      animaSynced: snapshot.anima.lastSynced > 0,
      openclawSynced: snapshot.openclaw.lastSynced > 0,
      memories: snapshot.anima.memories.length,
      history: snapshot.anima.recentHistory.length,
    },
  });
}
