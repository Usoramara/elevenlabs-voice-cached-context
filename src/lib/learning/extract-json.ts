/**
 * Extract JSON from text that may be wrapped in markdown code blocks.
 * Handles: plain JSON, ```json ... ```, ``` ... ```
 */
export function extractJSON(text: string): string {
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (match) return match[1].trim();
  return text.trim();
}
