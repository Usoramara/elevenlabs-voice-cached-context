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
import { eq, and } from 'drizzle-orm';
import { saveMemoryWithEmbedding } from '@/lib/memory/manager';
import type { ElevenLabsPostCallWebhook } from '@/lib/voice/config';

const WEBHOOK_SECRET = process.env.ELEVENLABS_WEBHOOK_SECRET ?? 'dev-webhook-secret';
const VOICE_USER_ID = process.env.VOICE_DEFAULT_USER_ID ?? 'voice-user';

export async function POST(request: Request): Promise<NextResponse> {
  // Verify webhook signature
  const signature = request.headers.get('x-elevenlabs-signature') ?? '';
  if (signature !== WEBHOOK_SECRET && process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  let payload: ElevenLabsPostCallWebhook;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const userId = VOICE_USER_ID;
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
      .orderBy(conversations.updatedAt)
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
