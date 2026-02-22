# Deployment Guide — ElevenLabs Voice Pipeline

Full deployment of the dual-layer cached context voice pipeline.

## Prerequisites

- Node.js 20+
- Accounts: [Anthropic](https://console.anthropic.com), [Neon](https://neon.tech), [ElevenLabs](https://elevenlabs.io), [Vercel](https://vercel.com)

## Step 1: Generate Secrets

```bash
bash scripts/generate-secrets.sh
```

This outputs two values you'll need:
- `ELEVENLABS_LLM_SECRET` — Bearer token for LLM proxy auth
- `ELEVENLABS_WEBHOOK_SECRET` — Webhook signature verification

Save both. You'll use them in your env vars AND in the ElevenLabs dashboard.

## Step 2: Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com) → Settings → API Keys
2. Create a new key
3. Save as `ANTHROPIC_API_KEY=sk-ant-...`
4. Add billing (the app uses `claude-sonnet-4-20250514`)

## Step 3: Neon PostgreSQL

1. Sign up at [neon.tech](https://neon.tech)
2. Create a new project (pick a region close to your Vercel deployment)
3. Run the pgvector setup in the Neon SQL Editor:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
   Or use the provided script: copy contents of `scripts/setup-db.sql`
4. Copy the connection string → `DATABASE_URL=postgresql://user:pass@host/db?sslmode=require`
5. Push the Drizzle schema:
   ```bash
   DATABASE_URL="postgresql://..." npx drizzle-kit push
   ```
6. Seed the default user:
   ```bash
   DATABASE_URL="postgresql://..." npx tsx scripts/seed.ts
   ```

This creates 5 tables: `users`, `conversations`, `messages`, `cognitive_states`, `memories` (with 384-dim vector column).

## Step 4: Deploy to Vercel

```bash
npm i -g vercel        # if not installed
cd "human voice"
vercel link            # link to your Vercel project
vercel --prod          # deploy
```

Note the production URL (e.g. `your-app.vercel.app`).

## Step 5: Set Environment Variables

Set these in the Vercel dashboard (Settings → Environment Variables) or via CLI:

```
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://user:pass@host/db?sslmode=require
ELEVENLABS_AGENT_ID=agent_...          # from Step 6
ELEVENLABS_LLM_SECRET=<from step 1>
ELEVENLABS_WEBHOOK_SECRET=<from step 1>
VOICE_DEFAULT_USER_ID=voice-user
NODE_ENV=production
```

After setting env vars, redeploy: `vercel --prod`

## Step 6: ElevenLabs Conversational AI Agent

1. Sign up at [elevenlabs.io](https://elevenlabs.io) (Creator plan minimum)
2. Go to **Conversational AI** → Create new agent
3. Configure the agent:
   - **Voice:** Pick a Norwegian voice (or preferred voice)
   - **Language:** Norwegian Bokmål (`nb-NO`) primary, English fallback
   - **TTS model:** `eleven_multilingual_v2`
4. Under **Custom LLM**:
   - URL: `https://your-app.vercel.app/api/voice/llm`
   - Authorization: `Bearer <your-ELEVENLABS_LLM_SECRET>`
5. Under **Webhooks** → Post-call:
   - URL: `https://your-app.vercel.app/api/voice/webhook`
   - Header: `x-elevenlabs-signature: <your-ELEVENLABS_WEBHOOK_SECRET>`
6. Copy the **Agent ID** → go back to Vercel and set `ELEVENLABS_AGENT_ID=agent_...`
7. Redeploy: `vercel --prod`

## Step 7: Verify

1. **Landing page** — visit your Vercel URL, confirms server is running
2. **Session endpoint:**
   ```bash
   curl -X POST https://your-app.vercel.app/api/voice/session
   ```
   Should return `{ "ok": true, "agentId": "agent_..." }`
3. **Cache state:**
   ```bash
   curl https://your-app.vercel.app/api/voice/openclaw
   ```
   Should return the default cognitive state
4. **Voice conversation** — test through the ElevenLabs agent widget
5. **After the call** — check `/api/voice/openclaw` for updated state

## Notes

- The HuggingFace embedding model (`Xenova/all-MiniLM-L6-v2`, ~83MB) downloads automatically on first memory save. The first call that triggers a memory write will be slower.
- Cache starts cold — call `POST /api/voice/session` before starting the ElevenLabs widget to warm it.
- The LLM proxy streams responses in OpenAI-compatible SSE format, so ElevenLabs can start TTS before Claude finishes generating.
- `vercel.json` sets function timeouts: 60s for LLM proxy (Claude streaming), 30s for webhook and session.
