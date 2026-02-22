/**
 * ElevenLabs Voice Pipeline Configuration
 *
 * Architecture: ElevenLabs Conversational AI → Custom LLM Proxy → Claude API
 * ElevenLabs handles: STT, VAD, turn-taking, interrupts, TTS (norsk)
 * We handle: ANIMA context enrichment, memory, cognitive state, DB persistence
 */

// ── ElevenLabs Agent Config ──

export const ELEVENLABS_AGENT_CONFIG = {
  // Set in ElevenLabs dashboard — these are reference values
  defaultVoice: 'nb-NO', // Norwegian Bokmål
  languages: ['nb', 'en'], // Norwegian primary, English fallback
  model: 'eleven_multilingual_v2', // Best Norwegian TTS
  sttModel: 'eleven_turbo_v2', // Fastest STT
} as const;

// ── Custom LLM Proxy Config ──

export const LLM_PROXY_CONFIG = {
  // Claude model used as the brain
  model: 'claude-sonnet-4-20250514',
  // Max tokens for voice responses (shorter = faster TTS)
  maxTokens: 200,
  // Temperature for conversational warmth
  temperature: 0.7,
  // Max conversation history turns to include
  maxHistoryTurns: 20,
  // Max memories to fetch per turn
  maxMemories: 5,
} as const;

// ── Webhook Secret ──
// Set via ELEVENLABS_WEBHOOK_SECRET env var

// ── Types ──

/** OpenAI-compatible chat completion request (what ElevenLabs sends us) */
export interface OpenAIChatRequest {
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  tools?: unknown[];
  // ElevenLabs custom fields (when "Custom LLM extra body" is enabled)
  elevenlabs_extra?: {
    conversation_id?: string;
    agent_id?: string;
  };
}

export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

/** OpenAI-compatible streaming response chunk */
export interface OpenAIStreamChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
    };
    finish_reason: string | null;
  }>;
}

/** Post-call webhook payload from ElevenLabs */
export interface ElevenLabsPostCallWebhook {
  agent_id: string;
  conversation_id: string;
  status: 'done' | 'error';
  transcript: Array<{
    role: 'agent' | 'user';
    message: string;
    timestamp?: number;
  }>;
  metadata?: Record<string, unknown>;
  analysis?: {
    summary?: string;
    evaluation_criteria_results?: Record<string, unknown>;
  };
  conversation_initiation_client_data?: Record<string, unknown>;
}

/** Voice session initialization data */
export interface VoiceSessionInit {
  agentId: string;
  conversationId: string; // Our DB conversation ID
  userId: string;
  initialContext: string; // ANIMA context snapshot
}
