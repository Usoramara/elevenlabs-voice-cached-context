# ElevenLabs Voice Pipeline with Cached Context

A dual-layer cached LLM proxy that sits between **ElevenLabs Conversational AI** and **Claude** — enriching every voice turn with cognitive state + identity context from an in-memory cache, achieving ~0ms context build time.

## Architecture

```
ElevenLabs Conversational AI
  │
  │  OpenAI-compatible chat request
  ▼
POST /api/voice/llm  (this server)
  │
  ├─ Read from dual-layer in-memory cache (~0ms)
  │   ├─ ANIMA layer: 6D cognitive state, episodic memories, history
  │   └─ OpenClaw layer: soul, identity, user profile, workspace rules
  │
  ├─ Build system prompt (pure function, no I/O)
  │
  ├─ Stream to Claude API
  │
  └─ Stream back to ElevenLabs TTS
      │
      └─ Async: write to DB, update cognitive state, store memories
```

### Dual-Layer Cache

| Layer | What | Stale After | Source |
|-------|------|-------------|--------|
| ANIMA | Cognitive state, episodic memories, conversation history | 30s | PostgreSQL + pgvector |
| OpenClaw | Soul identity, user profile, workspace rules, long-term memory | 5min | PostgreSQL (tagged memories) |

Both layers are read from cache on the hot path (every voice turn). DB sync happens async in the background.

## API Routes

| Route | Method | Purpose |
|-------|--------|---------|
| `/api/voice/llm` | POST | LLM proxy — ElevenLabs calls this instead of Claude directly |
| `/api/voice/session` | POST | Session init — warms cache, returns ElevenLabs config |
| `/api/voice/webhook` | POST | Post-call webhook — saves transcript summary as memory |
| `/api/voice/openclaw` | GET/POST | Read/update OpenClaw layer (soul, identity, user, memory) |

## Setup

### 1. Install

```bash
npm install
```

### 2. Database

Create a [Neon](https://neon.tech) PostgreSQL database with the pgvector extension:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Push the schema:

```bash
npx drizzle-kit push
```

Seed the default user:

```bash
npx tsx scripts/seed.ts
```

### 3. Environment

Copy `.env.example` to `.env` and fill in the values:

```bash
cp .env.example .env
```

### 4. Run

```bash
npm run dev
```

### 5. ElevenLabs Configuration

In your ElevenLabs Conversational AI agent dashboard:

1. Set **Custom LLM** URL to: `https://your-domain.com/api/voice/llm`
2. Add **Authorization** header: `Bearer <your ELEVENLABS_LLM_SECRET>`
3. Set **Post-call webhook** URL to: `https://your-domain.com/api/voice/webhook`
4. Add webhook header: `x-elevenlabs-signature: <your ELEVENLABS_WEBHOOK_SECRET>`

## Tech Stack

- **Next.js 16** — App router, API routes
- **Claude** (via `@anthropic-ai/sdk`) — LLM brain
- **Neon PostgreSQL** + **Drizzle ORM** — Database
- **pgvector** — Semantic memory search
- **HuggingFace Transformers** — Local embeddings (all-MiniLM-L6-v2, 384d)
- **ElevenLabs** — STT, VAD, turn-taking, TTS

## License

MIT
