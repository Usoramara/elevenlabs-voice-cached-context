/**
 * Voice Post-Call Webhook
 *
 * ElevenLabs calls this after a voice conversation ends.
 * We use it to:
 *   1. Write the full transcript to the DB (backup — LLM proxy writes per-turn)
 *   2. Generate a summary memory of the conversation
 *   3. Update the conversation title
 *   4. Ensure cognitive state is consistent
 */

import { NextResponse } from 'next/server';
import { getDb } from '@/db';
import { conversations } from '@/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { saveMemoryWithEmbedding } from '@/lib/memory/manager';
import { applyCognitiveShift } from '@/lib/voice/context-builder';
import { getContextSnapshot } from '@/lib/voice/context-cache';
import type { ElevenLabsPostCallWebhook } from '@/lib/voice/config';
import { resolveVoiceUserId } from '@/lib/voice/resolve-user';
import { reflectOnConversation } from '@/lib/learning/growth';
import {
  hasEnoughExchanges,
  getConversationData,
  markReflected,
  resetConversation,
} from '@/lib/learning/conversation-tracker';

function getWebhookSecret(): string {
  const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ELEVENLABS_WEBHOOK_SECRET is required in production');
  }
  return 'dev-webhook-secret';
}

export async function POST(request: Request): Promise<NextResponse> {
  // Verify webhook signature
  const signature = request.headers.get('x-elevenlabs-signature') ?? '';
  if (signature !== getWebhookSecret() && process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: ElevenLabsPostCallWebhook;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const userId = await resolveVoiceUserId();
  const { transcript, analysis, conversation_id: elevenLabsConvId } = payload;

  if (!transcript || transcript.length === 0) {
    return NextResponse.json({ ok: true, message: 'Empty transcript' });
  }

  try {
    const db = getDb();

    // Find the most recent voice conversation
    const [voiceConv] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.userId, userId),
          eq(conversations.title, '🎙️ Voice'),
        ),
      )
      .orderBy(desc(conversations.updatedAt))
      .limit(1);

    if (!voiceConv) {
      console.warn('No voice conversation found for post-call webhook');
      return NextResponse.json({ ok: true, message: 'No conversation found' });
    }

    const conversationId = voiceConv.id;

    // Generate a title from the conversation
    const firstUserMessage = transcript.find(t => t.role === 'user');
    const title = firstUserMessage
      ? `🎙️ ${firstUserMessage.message.slice(0, 40)}${firstUserMessage.message.length > 40 ? '...' : ''}`
      : '🎙️ Voice';

    // Update conversation title
    await db
      .update(conversations)
      .set({ title, updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));

    // Generate a summary memory of the full conversation
    const summaryContent = analysis?.summary
      ? `[stemmesamtale] ${analysis.summary}`
      : `[stemmesamtale] ${transcript.length} utvekslinger. ${
          firstUserMessage ? `Startet med: "${firstUserMessage.message.slice(0, 80)}"` : ''
        }`;

    // Save conversation summary as a memory
    await saveMemoryWithEmbedding({
      userId,
      type: 'episodic',
      content: summaryContent,
      significance: 0.6,
      tags: ['voice', 'conversation-summary', elevenLabsConvId ?? ''],
    });

    // Growth reflection — fire-and-forget
    runGrowthReflection(userId).catch(
      e => console.error('[webhook] Growth reflection error:', e),
    );

    return NextResponse.json({
      ok: true,
      conversationId,
      messageCount: transcript.length,
    });
  } catch (error) {
    console.error('Voice webhook error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    );
  }
}

// ── Growth Reflection (fire-and-forget) ──

async function runGrowthReflection(userId: string): Promise<void> {
  if (!hasEnoughExchanges(userId)) return;

  const data = getConversationData(userId);
  if (!data) return;

  // Get current valence for trajectory end
  const snapshot = getContextSnapshot(userId);
  data.trajectory.end = snapshot.anima.cognitiveState.valence;

  console.log('[webhook] Running growth reflection...');
  const insights = await reflectOnConversation({
    exchanges: data.exchanges,
    emotionalTrajectory: data.trajectory,
  });

  if (!insights) return;

  console.log('[webhook] Growth insights:', insights.keyTakeaway?.slice(0, 60));

  // Save key takeaway as high-significance memory
  if (insights.keyTakeaway) {
    await saveMemoryWithEmbedding({
      userId,
      type: 'semantic',
      content: `[Growth] ${insights.keyTakeaway}`,
      significance: 0.8,
      tags: ['growth', 'takeaway'],
    });
  }

  // Save emotional insight as memory
  if (insights.emotionalInsight) {
    await saveMemoryWithEmbedding({
      userId,
      type: 'semantic',
      content: `[Insight] ${insights.emotionalInsight}`,
      significance: 0.7,
      tags: ['growth', 'emotional-insight'],
    });
  }

  // Growth nudges cognitive state
  await applyCognitiveShift(userId, {
    confidence: 0.02,
    curiosity: 0.01,
  });

  // Mark reflected and reset for next conversation
  markReflected(userId);
  resetConversation(userId);
}
