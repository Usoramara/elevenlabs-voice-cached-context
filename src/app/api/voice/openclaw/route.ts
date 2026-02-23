/**
 * OpenClaw Layer Sync — Update soul/identity/user/memory
 *
 * Called by the text interface or admin panel to update the OpenClaw
 * layer. Updates cache immediately, writes to DB async.
 *
 * POST /api/voice/openclaw
 * Body: { soul?, identity?, user?, memory? }
 */

import { NextResponse } from 'next/server';
import { syncOpenClawToDb } from '@/lib/voice/context-builder';
import { getContextSnapshot } from '@/lib/voice/context-cache';
import { resolveVoiceUserId } from '@/lib/voice/resolve-user';

function getVoiceSecret(): string {
  const secret = process.env.ELEVENLABS_LLM_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ELEVENLABS_LLM_SECRET is required in production');
  }
  return 'dev-voice-secret';
}

export async function POST(request: Request): Promise<Response> {
  // Authenticate — same bearer token as LLM proxy
  const authHeader = request.headers.get('authorization');
  const providedSecret = authHeader?.replace('Bearer ', '') ?? '';

  if (providedSecret !== getVoiceSecret() && process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = await resolveVoiceUserId();

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { soul, identity, user, memory, agentKnowledge } = body as {
    soul?: string;
    identity?: { name: string; creature: string; vibe: string; emoji: string };
    user?: string;
    memory?: string;
    agentKnowledge?: string;
  };

  // Sync to cache (instant) + DB (async)
  await syncOpenClawToDb(userId, { soul, identity, user, memory, agentKnowledge });

  // Return updated snapshot
  const snapshot = getContextSnapshot(userId);

  return NextResponse.json({
    ok: true,
    openclaw: {
      identity: snapshot.openclaw.identity,
      soulLength: snapshot.openclaw.soul.length,
      userLength: snapshot.openclaw.user.length,
      memoryLength: snapshot.openclaw.memory.length,
      agentKnowledgeLength: snapshot.openclaw.agentKnowledge.length,
      lastSynced: snapshot.openclaw.lastSynced,
    },
  });
}

/** GET /api/voice/openclaw — Read current OpenClaw cache state */
export async function GET(): Promise<Response> {
  const userId = await resolveVoiceUserId();
  const snapshot = getContextSnapshot(userId);

  return NextResponse.json({
    identity: snapshot.openclaw.identity,
    soul: snapshot.openclaw.soul.slice(0, 200) + '...',
    user: snapshot.openclaw.user.slice(0, 200),
    workspaceRules: snapshot.openclaw.workspaceRules.slice(0, 200),
    memoryPreview: snapshot.openclaw.memory.slice(0, 200),
    agentKnowledgePreview: snapshot.openclaw.agentKnowledge.slice(0, 200) + '...',
    lastSynced: snapshot.openclaw.lastSynced,
    anima: {
      cognitiveState: snapshot.anima.cognitiveState,
      memories: snapshot.anima.memories.length,
      history: snapshot.anima.recentHistory.length,
      lastSynced: snapshot.anima.lastSynced,
    },
  });
}
