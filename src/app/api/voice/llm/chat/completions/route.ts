// ElevenLabs appends /chat/completions to the server URL.
// Forward to the parent LLM proxy handler.
import { POST as llmHandler } from '../../route';

export async function POST(request: Request): Promise<Response> {
  return llmHandler(request);
}
