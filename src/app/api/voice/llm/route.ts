/**
 * Voice LLM Proxy — Dual-Layer Cache-First Architecture
 *
 * ElevenLabs Conversational AI calls this instead of Claude directly.
 * We enrich every request with both ANIMA + OpenClaw context from an
 * in-memory cache, then forward to Claude and stream back.
 *
 * ┌─────────────────────────────────────────────────────┐
 * │  HOT PATH (every voice turn, ~0ms context build)    │
 * │                                                      │
 * │  ElevenLabs STT → transcribed text                   │
 * │  → POST /api/voice/llm                               │
 * │  → Read ANIMA + OpenClaw from in-memory cache        │
 * │  → Build dual-layer system prompt (pure function)    │
 * │  → Stream Claude response to ElevenLabs TTS          │
 * │                                                      │
 * │  SIMULTANEOUSLY (fire-and-forget):                   │
 * │  → Write user message to DB                          │
 * │  → Update cache with new history entry               │
 * │  → Trigger stale cache refresh if needed             │
 * └─────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────┐
 * │  COLD PATH (after response, async)                   │
 * │                                                      │
 * │  → Parse emotion shift from Claude response          │
 * │  → Update cognitive state (cache instant, DB async)  │
 * │  → Write assistant message to DB                     │
 * │  → Store memory if significant (DB async)            │
 * │  → Refresh stale cache layers (DB async)             │
 * └─────────────────────────────────────────────────────┘
 */

import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '@/db';
import { messages, conversations } from '@/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { saveMemoryWithEmbedding } from '@/lib/memory/manager';
import {
  buildVoiceSystemPrompt,
  warmCache,
  applyCognitiveShift,
  parseEmotionShift,
  appendHistoryToCache,
} from '@/lib/voice/context-builder';
import { LLM_PROXY_CONFIG } from '@/lib/voice/config';
import type { OpenAIChatRequest } from '@/lib/voice/config';
import { resolveVoiceUserId } from '@/lib/voice/resolve-user';

// ── Auth ──
function getVoiceSecret(): string {
  const secret = process.env.ELEVENLABS_LLM_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ELEVENLABS_LLM_SECRET is required in production');
  }
  return 'dev-voice-secret';
}

// ── Claude client ──
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ── Track warm status per user ──
const warmedUsers = new Set<string>();

export async function POST(request: Request): Promise<Response> {
  // Authenticate
  const authHeader = request.headers.get('authorization');
  const providedSecret = authHeader?.replace('Bearer ', '') ?? '';

  if (providedSecret !== getVoiceSecret() && process.env.NODE_ENV !== 'development') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: OpenAIChatRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { messages: chatMessages, stream = true } = body;
  const userId = await resolveVoiceUserId();

  // ── Warm cache on first call (async, doesn't block) ──
  if (!warmedUsers.has(userId)) {
    warmedUsers.add(userId);
    // Fire-and-forget: cache warms in background, first call uses defaults
    warmCache(userId).catch(e => console.error('[voice] Cache warm failed:', e));
  }

  // ── Get or create voice conversation (fire-and-forget the DB part) ──
  const conversationId = await getOrCreateVoiceConversation(userId);

  // Extract messages
  const systemMessages = chatMessages.filter(m => m.role === 'system');
  const chatHistory = chatMessages.filter(m => m.role !== 'system');
  const latestUserMsg = [...chatHistory].reverse().find(m => m.role === 'user');
  const userText = latestUserMsg?.content ?? '';

  // ── Write user message: cache NOW, DB async ──
  if (userText) {
    // Cache update is instant (~0ms)
    appendHistoryToCache(userId, { role: 'user', content: userText });
    // DB write is fire-and-forget
    writeMessage(conversationId, 'user', userText).catch(
      e => console.error('[voice] User msg write failed:', e),
    );
  }

  // ── Build dual-layer system prompt from CACHE (pure, ~0ms) ──
  const animaSystemPrompt = buildVoiceSystemPrompt(userId, userText, conversationId);

  // Merge with ElevenLabs' system prompt if present
  const elevenLabsSystem = systemMessages.map(m => m.content).join('\n');
  const fullSystemPrompt = elevenLabsSystem
    ? `${elevenLabsSystem}\n\n${animaSystemPrompt}`
    : animaSystemPrompt;

  // Convert OpenAI messages to Anthropic format (Claude rejects whitespace-only content)
  const anthropicMessages: Anthropic.MessageParam[] = chatHistory
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .filter(m => typeof m.content === 'string' && m.content.trim())
    .map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content!,
    }));

  if (anthropicMessages.length === 0 || anthropicMessages[0].role !== 'user') {
    anthropicMessages.unshift({ role: 'user', content: userText || 'Hei' });
  }

  // ── Stream or non-stream ──
  if (stream) {
    return handleStreaming(fullSystemPrompt, anthropicMessages, userId, conversationId);
  }
  return handleNonStreaming(fullSystemPrompt, anthropicMessages, userId, conversationId);
}

// ── Streaming response (SSE, OpenAI format) ──

function handleStreaming(
  systemPrompt: string,
  msgs: Anthropic.MessageParam[],
  userId: string,
  conversationId: string,
): Response {
  const encoder = new TextEncoder();
  let fullText = '';

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const response = await anthropic.messages.create({
          model: LLM_PROXY_CONFIG.model,
          max_tokens: LLM_PROXY_CONFIG.maxTokens,
          system: systemPrompt,
          messages: msgs,
          stream: true,
        });

        const streamId = `chatcmpl-${Date.now()}`;

        for await (const event of response) {
          if (event.type === 'content_block_delta') {
            const delta = event.delta;
            if ('text' in delta) {
              fullText += delta.text;

              // Don't stream SHIFT line to TTS
              if (!delta.text.includes('SHIFT:')) {
                const chunk = formatSSEChunk(streamId, delta.text);
                controller.enqueue(encoder.encode(chunk));
              }
            }
          }
        }

        // Send stop
        controller.enqueue(encoder.encode(formatSSEChunk(streamId, null, 'stop')));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();

        // ── Post-response: cache NOW, DB async ──
        processAfterResponse(fullText, userId, conversationId).catch(
          e => console.error('[voice] Post-response error:', e),
        );
      } catch (error) {
        console.error('[voice] Streaming error:', error);
        const errId = `err-${Date.now()}`;
        controller.enqueue(encoder.encode(formatSSEChunk(errId, 'Beklager, noe gikk galt.')));
        controller.enqueue(encoder.encode(formatSSEChunk(errId, null, 'stop')));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}

// ── Non-streaming response ──

async function handleNonStreaming(
  systemPrompt: string,
  msgs: Anthropic.MessageParam[],
  userId: string,
  conversationId: string,
): Promise<Response> {
  try {
    const response = await anthropic.messages.create({
      model: LLM_PROXY_CONFIG.model,
      max_tokens: LLM_PROXY_CONFIG.maxTokens,
      system: systemPrompt,
      messages: msgs,
    });

    const fullText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    const { cleanText } = parseEmotionShift(fullText);

    // Post-process (cache now, DB async)
    processAfterResponse(fullText, userId, conversationId).catch(
      e => console.error('[voice] Post-response error:', e),
    );

    return NextResponse.json({
      id: `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: LLM_PROXY_CONFIG.model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: cleanText },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
      },
    });
  } catch (error) {
    console.error('[voice] LLM error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ── Post-response: updates cache FIRST (instant), then DB (async) ──

async function processAfterResponse(
  fullText: string,
  userId: string,
  conversationId: string,
): Promise<void> {
  const { cleanText, shift } = parseEmotionShift(fullText);

  // 1. Update cache instantly
  appendHistoryToCache(userId, { role: 'assistant', content: cleanText });

  // 2. Write assistant message to DB (async)
  await writeMessage(conversationId, 'assistant', cleanText, shift);

  // 3. Apply cognitive shift (cache instant, DB async)
  if (shift) {
    await applyCognitiveShift(userId, shift);
  }

  // 4. Store significant interactions as memories (DB async)
  const significance = computeSignificance(cleanText, shift);
  if (significance > 0.4) {
    try {
      await saveMemoryWithEmbedding({
        userId,
        type: 'episodic',
        content: `[stemme] ${cleanText}`,
        significance,
        tags: ['voice', 'conversation'],
      });
    } catch (e) {
      console.error('[voice] Memory save error:', e);
    }
  }
}

// ── DB helpers ──

async function getOrCreateVoiceConversation(userId: string): Promise<string> {
  const db = getDb();

  const [existing] = await db
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

  if (existing) {
    // Touch async
    db.update(conversations)
      .set({ updatedAt: new Date() })
      .where(eq(conversations.id, existing.id))
      .catch(() => {});
    return existing.id;
  }

  const [conv] = await db
    .insert(conversations)
    .values({ userId, title: '🎙️ Voice' })
    .returning({ id: conversations.id });

  return conv.id;
}

async function writeMessage(
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  emotionShift?: Partial<Record<string, number>> | null,
): Promise<void> {
  if (!content.trim()) return;

  const db = getDb();
  await db.insert(messages).values({
    conversationId,
    role,
    content,
    emotionShift: emotionShift ?? null,
    metadata: { channel: 'voice', timestamp: Date.now() },
  });

  // Touch conversation timestamp (fire-and-forget)
  db.update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId))
    .catch(() => {});
}

function computeSignificance(
  text: string,
  shift: Partial<Record<string, number>> | null,
): number {
  let sig = 0.3;
  if (shift) {
    const intensity = Object.values(shift).reduce<number>((sum, v) => sum + Math.abs(v ?? 0), 0);
    sig += Math.min(intensity * 0.5, 0.3);
  }
  if (text.length > 100) sig += 0.1;
  if (text.length > 300) sig += 0.1;

  const emotionalWords = /\b(elsker|hater|savner|redd|glad|trist|sint|takk|unnskyld|beklager|love|miss|afraid|happy|sad)\b/i;
  if (emotionalWords.test(text)) sig += 0.15;

  return Math.min(sig, 1.0);
}

// ── SSE formatting ──

function formatSSEChunk(
  id: string,
  content: string | null,
  finishReason: string | null = null,
): string {
  return `data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: LLM_PROXY_CONFIG.model,
    choices: [{
      index: 0,
      delta: content !== null ? { content } : {},
      finish_reason: finishReason,
    }],
  })}\n\n`;
}
