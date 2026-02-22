#!/usr/bin/env bash
# Generate deployment secrets for ElevenLabs Voice Pipeline
# Usage: bash scripts/generate-secrets.sh

set -euo pipefail

echo "Generating deployment secrets..."
echo ""

LLM_SECRET=$(openssl rand -base64 32)
WEBHOOK_SECRET=$(openssl rand -base64 32)

echo "Add these to your .env or hosting environment variables:"
echo ""
echo "ELEVENLABS_LLM_SECRET=${LLM_SECRET}"
echo "ELEVENLABS_WEBHOOK_SECRET=${WEBHOOK_SECRET}"
echo ""
echo "Done. Keep these values — you'll also need them in the ElevenLabs dashboard."
