/**
 * Cached voice userId resolver.
 *
 * Eliminates the hardcoded VOICE_USER_ID constant from all voice routes.
 * Looks up the canonical user once, caches in-memory for 5 minutes,
 * and falls back to 'voice-user' if DB is unreachable.
 *
 * After Clerk migration, the resolver automatically picks up the new
 * Clerk userId on next cache refresh — no restart or env var change needed.
 */

import { getDb } from '@/db';
import { users } from '@/db/schema';

let cachedUserId: string | null = null;
let cachedAt = 0;
const CACHE_TTL = 300_000; // 5 min

export async function resolveVoiceUserId(): Promise<string> {
  // Env override always wins
  const envId = process.env.VOICE_DEFAULT_USER_ID;
  if (envId) return envId;

  // Return cached if fresh
  if (cachedUserId && Date.now() - cachedAt < CACHE_TTL) return cachedUserId;

  try {
    const db = getDb();
    const [user] = await db.select({ id: users.id }).from(users).limit(1);
    cachedUserId = user?.id ?? 'voice-user';
    cachedAt = Date.now();
    return cachedUserId;
  } catch {
    return cachedUserId ?? 'voice-user';
  }
}
