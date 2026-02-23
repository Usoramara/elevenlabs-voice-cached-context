#!/usr/bin/env bash
# Configure ElevenLabs Conversational AI agent via PATCH API
# Reads ELEVENLABS_API_KEY and ELEVENLABS_AGENT_ID from .env
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Load .env
if [[ -f "$PROJECT_DIR/.env" ]]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
else
  echo "ERROR: .env not found at $PROJECT_DIR/.env"
  exit 1
fi

if [[ -z "${ELEVENLABS_API_KEY:-}" ]]; then
  echo "ERROR: ELEVENLABS_API_KEY not set"
  exit 1
fi
if [[ -z "${ELEVENLABS_AGENT_ID:-}" ]]; then
  echo "ERROR: ELEVENLABS_AGENT_ID not set"
  exit 1
fi

AGENT_ID="$ELEVENLABS_AGENT_ID"
API_KEY="$ELEVENLABS_API_KEY"
BASE_URL="https://human-voice.vercel.app"

echo "Configuring agent: $AGENT_ID"
echo "Custom LLM URL:    $BASE_URL/api/voice/llm"
echo ""

RESPONSE=$(curl -s -w "\n%{http_code}" -X PATCH \
  "https://api.elevenlabs.io/v1/convai/agents/$AGENT_ID" \
  -H "xi-api-key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "conversation_config": {
      "agent": {
        "language": "no",
        "first_message": "\n\n",
        "prompt": {
          "llm": "custom-llm",
          "custom_llm": {
            "url": "'"$BASE_URL"'/api/voice/llm"
          }
        }
      },
      "tts": {
        "model_id": "eleven_turbo_v2_5",
        "voice_id": "CMVyxPycEkgLpEF85ShA"
      },
      "turn": {
        "turn_timeout": 10,
        "silence_end_call_timeout": -1,
        "turn_eagerness": "patient",
        "speculative_turn": false
      },
      "conversation": {
        "max_duration_seconds": 1800
      }
    },
    "platform_settings": {
      "auth": {
        "enable_auth": true
      }
    }
  }')

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "HTTP Status: $HTTP_CODE"

if [[ "$HTTP_CODE" -ge 200 && "$HTTP_CODE" -lt 300 ]]; then
  echo "SUCCESS — Agent updated."
  echo ""
  echo "Response:"
  echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
else
  echo "FAILED"
  echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
  exit 1
fi

echo ""
echo "--- Verifying: GET agent config ---"
echo ""

VERIFY=$(curl -s -w "\n%{http_code}" \
  "https://api.elevenlabs.io/v1/convai/agents/$AGENT_ID" \
  -H "xi-api-key: $API_KEY")

V_CODE=$(echo "$VERIFY" | tail -1)
V_BODY=$(echo "$VERIFY" | sed '$d')

if [[ "$V_CODE" -ge 200 && "$V_CODE" -lt 300 ]]; then
  echo "Language:    $(echo "$V_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['conversation_config']['agent']['language'])" 2>/dev/null || echo "?")"
  echo "Voice ID:    $(echo "$V_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['conversation_config']['tts']['voice_id'])" 2>/dev/null || echo "?")"
  echo "TTS Model:   $(echo "$V_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['conversation_config']['tts']['model_id'])" 2>/dev/null || echo "?")"
  echo "Auth:        $(echo "$V_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['platform_settings']['auth']['enable_auth'])" 2>/dev/null || echo "?")"
  echo "LLM URL:     $(echo "$V_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['conversation_config']['agent']['prompt']['custom_llm']['url'])" 2>/dev/null || echo "?")"
  echo "Turn timeout: $(echo "$V_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['conversation_config']['turn']['turn_timeout'])" 2>/dev/null || echo "?")"
  echo "Silence end:  $(echo "$V_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['conversation_config']['turn']['silence_end_call_timeout'])" 2>/dev/null || echo "?")"
  echo "Eagerness:    $(echo "$V_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['conversation_config']['turn']['turn_eagerness'])" 2>/dev/null || echo "?")"
  echo "Max duration: $(echo "$V_BODY" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['conversation_config']['conversation']['max_duration_seconds'])" 2>/dev/null || echo "?")"
else
  echo "Verification GET failed ($V_CODE)"
  echo "$V_BODY"
fi

echo ""
echo "REMINDER: Post-call webhook must be configured manually in ElevenLabs dashboard."
echo "Webhook URL: $BASE_URL/api/voice/webhook"
