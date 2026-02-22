export default function Home() {
  return (
    <main style={{ fontFamily: 'system-ui', maxWidth: 600, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>ElevenLabs Voice Pipeline</h1>
      <p>Dual-layer cached LLM proxy for ElevenLabs Conversational AI + Claude.</p>

      <h2>API Routes</h2>
      <ul>
        <li><code>POST /api/voice/llm</code> — LLM proxy (ElevenLabs calls this)</li>
        <li><code>POST /api/voice/session</code> — Session initialization</li>
        <li><code>POST /api/voice/webhook</code> — Post-call webhook</li>
        <li><code>GET|POST /api/voice/openclaw</code> — OpenClaw layer CRUD</li>
      </ul>

      <h2>Status</h2>
      <p>Server is running.</p>
    </main>
  );
}
