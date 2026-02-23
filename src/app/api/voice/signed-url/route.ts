/**
 * Signed URL — Keeps ElevenLabs API key server-side
 *
 * GET /api/voice/signed-url
 *
 * Calls the ElevenLabs API to get a signed WebSocket URL
 * that the client can use to connect directly.
 */

import { NextResponse } from 'next/server';

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_AGENT_ID = process.env.ELEVENLABS_AGENT_ID;

export async function GET(): Promise<Response> {
  if (!ELEVENLABS_API_KEY) {
    return NextResponse.json(
      { error: 'ELEVENLABS_API_KEY not configured' },
      { status: 500 },
    );
  }

  if (!ELEVENLABS_AGENT_ID) {
    return NextResponse.json(
      { error: 'ELEVENLABS_AGENT_ID not configured' },
      { status: 500 },
    );
  }

  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
    {
      method: 'GET',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY },
    },
  );

  if (!res.ok) {
    const text = await res.text();
    console.error('[signed-url] ElevenLabs error:', res.status, text);
    return NextResponse.json(
      { error: 'Failed to get signed URL' },
      { status: res.status },
    );
  }

  const data = await res.json();
  return NextResponse.json({ signedUrl: data.signed_url });
}
