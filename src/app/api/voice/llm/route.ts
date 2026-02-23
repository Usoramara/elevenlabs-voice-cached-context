/**
 * Voice LLM Proxy — Dual-Layer Cache-First Architecture + Tool Loop
 *
 * ElevenLabs Conversational AI calls this instead of Claude directly.
 * We enrich every request with both ANIMA + OpenClaw context from an
 * in-memory cache, then forward to Claude and stream back.
 *
 * Tool Architecture:
 * The SSE response stream stays OPEN across multiple Claude API calls.
 * When Claude wants a tool:
 *   Round 1: Claude streams "La meg sjekke det..." + tool_use block
 *     → text streams to TTS immediately (user hears filler)
 *     → tool executes (1-5s, but user already heard speech)
 *   Round 2: Claude streams tool result answer
 *     → answer streams to TTS (user hears the answer)
 *     → SSE stream closes normally
 */

import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '@/db';
import { messages, conversations } from '@/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { saveMemoryWithEmbedding, searchMemories } from '@/lib/memory/manager';
import {
  buildVoiceSystemPrompt,
  warmCache,
  applyCognitiveShift,
  parseEmotionShift,
  appendHistoryToCache,
} from '@/lib/voice/context-builder';
import { getContextSnapshot, updateAnimaCache } from '@/lib/voice/context-cache';
import { LLM_PROXY_CONFIG } from '@/lib/voice/config';
import type { OpenAIChatRequest } from '@/lib/voice/config';
import { resolveVoiceUserId } from '@/lib/voice/resolve-user';
import { detectEmotion } from '@/lib/learning/detect-emotion';
import { computeEmpathicCoupling } from '@/lib/learning/empathic-coupling';
import { inferToM, getToMSummary, checkPrediction } from '@/lib/learning/theory-of-mind';
import { trackExchange, trackEmotionalPeak } from '@/lib/learning/conversation-tracker';
import { tools } from '@/lib/tools/registry';
import { executeTool } from '@/lib/tools/executor';
import type { ToolCall } from '@/lib/tools/executor';

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

  // ── Warm cache on first call (await to ensure real context) ──
  if (!warmedUsers.has(userId)) {
    warmedUsers.add(userId);
    try {
      await warmCache(userId);
    } catch (e) {
      console.error('[voice] Cache warm failed:', e);
    }
  }

  // ── Get or create voice conversation (fire-and-forget the DB part) ──
  const conversationId = await getOrCreateVoiceConversation(userId);

  // Extract messages
  const systemMessages = chatMessages.filter(m => m.role === 'system');
  const chatHistory = chatMessages.filter(m => m.role !== 'system');
  const latestUserMsg = [...chatHistory].reverse().find(m => m.role === 'user');
  const userText = latestUserMsg?.content ?? '';

  // ── Fresh per-turn memory search (replaces stale cache approach) ──
  if (userText) {
    const freshMemories = await searchMemories(userId, userText, 5, 0.35).catch(() => []);
    if (freshMemories.length > 0) {
      updateAnimaCache(userId, { memories: freshMemories.map(m => m.content) });
    }
  }

  // ── Write user message: cache NOW, DB async ──
  if (userText) {
    appendHistoryToCache(userId, { role: 'user', content: userText });
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

// ── Streaming response with tool loop (SSE, OpenAI format) ──

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
      const streamId = `chatcmpl-${Date.now()}`;

      const enqueue = (text: string) => {
        controller.enqueue(encoder.encode(formatSSEChunk(streamId, text)));
      };

      try {
        // Multi-round tool loop — keeps SSE stream open across rounds
        const loopMessages = [...msgs];
        let inShiftLine = false;

        for (let round = 0; round <= LLM_PROXY_CONFIG.maxToolRounds; round++) {
          // Determine max_tokens for this round
          const isLastRound = round === LLM_PROXY_CONFIG.maxToolRounds;
          const isAnswerRound = round > 0;
          const roundMaxTokens = (isLastRound || isAnswerRound)
            ? LLM_PROXY_CONFIG.finalRoundMaxTokens
            : LLM_PROXY_CONFIG.maxTokens;

          const response = await anthropic.messages.create({
            model: LLM_PROXY_CONFIG.model,
            max_tokens: roundMaxTokens,
            system: systemPrompt,
            messages: loopMessages,
            tools,
            stream: true,
          });

          // Track tool_use blocks in this round
          const toolUseBlocks: Array<{ id: string; name: string; inputJson: string }> = [];
          let currentToolId = '';
          let currentToolName = '';
          let currentToolInputJson = '';
          let stopReason = '';

          for await (const event of response) {
            switch (event.type) {
              case 'content_block_start':
                if (event.content_block.type === 'tool_use') {
                  currentToolId = event.content_block.id;
                  currentToolName = event.content_block.name;
                  currentToolInputJson = '';
                }
                break;

              case 'content_block_delta':
                if (event.delta.type === 'text_delta') {
                  const text = event.delta.text;
                  fullText += text;

                  if (inShiftLine) continue;

                  if (text.includes('SHIFT:')) {
                    const beforeShift = text.split('SHIFT:')[0].replace(/\n$/, '');
                    if (beforeShift) enqueue(beforeShift);
                    inShiftLine = true;
                    continue;
                  }

                  if (fullText.includes('SHIFT:')) {
                    inShiftLine = true;
                    continue;
                  }

                  enqueue(text);
                } else if (event.delta.type === 'input_json_delta') {
                  currentToolInputJson += event.delta.partial_json;
                }
                break;

              case 'content_block_stop':
                if (currentToolId) {
                  toolUseBlocks.push({
                    id: currentToolId,
                    name: currentToolName,
                    inputJson: currentToolInputJson,
                  });
                  currentToolId = '';
                  currentToolName = '';
                  currentToolInputJson = '';
                }
                break;

              case 'message_delta':
                stopReason = event.delta.stop_reason ?? '';
                break;
            }
          }

          // If no tool use, we're done — break out of loop
          if (stopReason !== 'tool_use' || toolUseBlocks.length === 0) {
            break;
          }

          // Execute all tools from this round
          console.log(`[voice] Round ${round}: executing ${toolUseBlocks.length} tool(s): ${toolUseBlocks.map(t => t.name).join(', ')}`);

          const toolResults = await Promise.all(
            toolUseBlocks.map(async (block) => {
              let input: Record<string, unknown> = {};
              try {
                input = JSON.parse(block.inputJson || '{}');
              } catch {
                input = {};
              }

              const toolCall: ToolCall = {
                id: block.id,
                name: block.name,
                input,
                userId,
              };

              return executeTool(toolCall);
            }),
          );

          // Build the assistant message content (text + tool_use blocks)
          const assistantContent: Anthropic.ContentBlockParam[] = [];

          // Add any text that was streamed before tools
          const textBeforeTools = fullText;
          if (textBeforeTools.trim()) {
            assistantContent.push({ type: 'text', text: textBeforeTools });
          }

          // Add tool_use blocks
          for (const block of toolUseBlocks) {
            let parsedInput: Record<string, unknown> = {};
            try {
              parsedInput = JSON.parse(block.inputJson || '{}');
            } catch {
              parsedInput = {};
            }
            assistantContent.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: parsedInput,
            });
          }

          // Add assistant message with tool_use blocks
          loopMessages.push({ role: 'assistant', content: assistantContent });

          // Add tool results as user message
          const toolResultContent: Anthropic.ToolResultBlockParam[] = toolResults.map(r => ({
            type: 'tool_result' as const,
            tool_use_id: r.tool_use_id,
            content: r.content,
            is_error: r.is_error,
          }));

          loopMessages.push({ role: 'user', content: toolResultContent });

          // Reset fullText for the next round (answer round)
          // Defensive: check for partial SHIFT prefix at end of fullText
          const SHIFT_PREFIXES = ['SHIFT:', 'SHIFT', 'SHIF', 'SHI', '\nSHIFT:', '\nSHIFT', '\nSHIF', '\nSHI'];
          const hasPartialShift = SHIFT_PREFIXES.some(p => fullText.endsWith(p));
          if (!hasPartialShift) {
            inShiftLine = false;
          }
          fullText = '';
        }

        // Send stop
        controller.enqueue(encoder.encode(formatSSEChunk(streamId, null, 'stop')));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();

        // ── Post-response: cache NOW, DB async ──
        // fullText contains only the final round's text
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

// ── Non-streaming response with tool loop ──

async function handleNonStreaming(
  systemPrompt: string,
  msgs: Anthropic.MessageParam[],
  userId: string,
  conversationId: string,
): Promise<Response> {
  try {
    const loopMessages = [...msgs];
    let lastResponse: Anthropic.Message | null = null;

    for (let round = 0; round <= LLM_PROXY_CONFIG.maxToolRounds; round++) {
      const isLastRound = round === LLM_PROXY_CONFIG.maxToolRounds;
      const isAnswerRound = round > 0;
      const roundMaxTokens = (isLastRound || isAnswerRound)
        ? LLM_PROXY_CONFIG.finalRoundMaxTokens
        : LLM_PROXY_CONFIG.maxTokens;

      const response = await anthropic.messages.create({
        model: LLM_PROXY_CONFIG.model,
        max_tokens: roundMaxTokens,
        system: systemPrompt,
        messages: loopMessages,
        tools,
      });

      lastResponse = response;

      // Extract tool_use blocks
      const toolUseBlocks = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      // If no tool use, we're done
      if (response.stop_reason !== 'tool_use' || toolUseBlocks.length === 0) {
        break;
      }

      // Execute tools
      console.log(`[voice] Non-stream round ${round}: executing ${toolUseBlocks.length} tool(s)`);

      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block) => {
          const toolCall: ToolCall = {
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
            userId,
          };
          return executeTool(toolCall);
        }),
      );

      // Add assistant response and tool results to conversation
      loopMessages.push({ role: 'assistant', content: response.content });

      const toolResultContent: Anthropic.ToolResultBlockParam[] = toolResults.map(r => ({
        type: 'tool_result' as const,
        tool_use_id: r.tool_use_id,
        content: r.content,
        is_error: r.is_error,
      }));

      loopMessages.push({ role: 'user', content: toolResultContent });
    }

    if (!lastResponse) {
      return NextResponse.json({ error: 'No response from Claude' }, { status: 500 });
    }

    const fullText = lastResponse.content
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
        prompt_tokens: lastResponse.usage.input_tokens,
        completion_tokens: lastResponse.usage.output_tokens,
        total_tokens: lastResponse.usage.input_tokens + lastResponse.usage.output_tokens,
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

  // 3. Track exchange for growth engine
  const snapshot = getContextSnapshot(userId);
  trackExchange(userId, 'assistant', cleanText, snapshot.anima.cognitiveState.valence);

  // 4. Apply cognitive shift from SHIFT line (cache instant, DB async)
  if (shift) {
    await applyCognitiveShift(userId, shift);
  }

  // 5. Store significant interactions as memories (DB async)
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

  // 6. Fire-and-forget: learning engines (zero latency on hot path)
  runLearningEngines(userId, cleanText, shift).catch(
    e => console.error('[learning] Engine error:', e),
  );
}

// ── Learning engines: fire-and-forget post-response ──

async function runLearningEngines(
  userId: string,
  assistantText: string,
  shift: Partial<Record<string, number>> | null,
): Promise<void> {
  const snapshot = getContextSnapshot(userId);
  const history = snapshot.anima.recentHistory;
  const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
  if (!lastUserMsg) return;

  const userText = lastUserMsg.content;

  trackExchange(userId, 'user', userText, snapshot.anima.cognitiveState.valence);

  const [emotionResult, tomResult] = await Promise.all([
    detectEmotion(userText, assistantText.slice(0, 100)),
    inferToM({
      userId,
      content: userText,
      currentEmotions: undefined,
    }),
  ]);

  console.log('[learning] Emotion detected:', {
    emotions: emotionResult.emotions,
    valence: emotionResult.valence,
    confidence: emotionResult.confidence,
  });

  for (const emotion of emotionResult.emotions) {
    trackEmotionalPeak(userId, emotion);
  }

  const coupling = computeEmpathicCoupling(emotionResult);

  if (coupling.couplingIntensity > 0) {
    console.log('[learning] Empathic coupling:', {
      intensity: coupling.couplingIntensity.toFixed(2),
      hasGrief: coupling.hasGrief,
      nudges: coupling.nudges,
    });
  }

  const combinedNudges = { ...coupling.nudges };
  if (tomResult && checkPrediction(userId, userText)) {
    combinedNudges.confidence = (combinedNudges.confidence ?? 0) + 0.05;
    console.log('[learning] ToM prediction validated — confidence +0.05');
  }

  const hasNudges = Object.values(combinedNudges).some(v => v !== 0 && v !== undefined);
  if (hasNudges) {
    await applyCognitiveShift(userId, combinedNudges);
  }

  const tomSummary = getToMSummary(userId);
  if (tomSummary) {
    updateAnimaCache(userId, { tomSummary });
    console.log('[learning] ToM summary:', tomSummary.slice(0, 80));
  }

  if (tomResult && emotionResult.confidence > 0.5) {
    const enrichedContent = `[stemme] ${userText} — Følte: ${emotionResult.emotions.join(', ')}. ${tomResult.thinking}`;
    try {
      await saveMemoryWithEmbedding({
        userId,
        type: 'episodic',
        content: enrichedContent,
        significance: 0.5 + emotionResult.confidence * 0.3,
        tags: ['voice', 'learning', 'tom-enriched'],
      });
    } catch (e) {
      console.error('[learning] Enriched memory save error:', e);
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
