/**
 * Growth Reflection — Haiku post-conversation analysis.
 * Mirrors alive-intelligence-v3/src/app/api/mind/grow/route.ts
 */

import Anthropic from '@anthropic-ai/sdk';
import { extractJSON } from './extract-json';

export interface GrowthInsights {
  keyTakeaway: string;
  emotionalInsight: string;
  whatWentWell: string;
  whatToImprove: string;
  relationshipNote: string;
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function reflectOnConversation(params: {
  exchanges: Array<{ role: 'user' | 'assistant'; content: string }>;
  emotionalTrajectory: { start: number; end: number; peaks: string[] };
}): Promise<GrowthInsights | null> {
  try {
    const conversationSummary = params.exchanges
      .map(e => `${e.role === 'user' ? 'User' : 'Wybe'}: ${e.content}`)
      .join('\n');

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: `You are Wybe's self-reflection system. After a conversation ends, analyze what happened and extract growth insights.
Return ONLY valid JSON:
{
  "keyTakeaway": "One sentence about what was learned or what mattered",
  "emotionalInsight": "One sentence about the emotional dynamics",
  "whatWentWell": "Brief note on what worked",
  "whatToImprove": "Brief note on what could be better next time",
  "relationshipNote": "Brief note about the relationship with this person"
}
Be honest and specific. Don't be generic.`,
      messages: [
        {
          role: 'user',
          content: `Conversation (${params.exchanges.length} exchanges):
${conversationSummary}

Emotional trajectory: started at valence ${params.emotionalTrajectory.start.toFixed(2)}, ended at ${params.emotionalTrajectory.end.toFixed(2)}
Emotional peaks: ${params.emotionalTrajectory.peaks.join(', ') || 'none notable'}

Analyze this conversation:`,
        },
      ],
    });

    const responseText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    return JSON.parse(extractJSON(responseText)) as GrowthInsights;
  } catch (e) {
    console.error('[learning] Growth reflection failed:', e);
    return null;
  }
}
