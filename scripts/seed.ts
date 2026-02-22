/**
 * Seed script — creates default user and cognitive state.
 *
 * Usage: npx tsx scripts/seed.ts
 */

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from '../src/db/schema';

async function seed() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const sql = neon(databaseUrl);
  const db = drizzle(sql, { schema });

  const userId = process.env.VOICE_DEFAULT_USER_ID ?? 'voice-user';

  console.log(`Seeding user: ${userId}`);

  // Upsert user
  await db
    .insert(schema.users)
    .values({
      id: userId,
      email: 'voice@localhost',
      displayName: 'Voice User',
    })
    .onConflictDoNothing();

  // Upsert cognitive state with defaults
  await db
    .insert(schema.cognitiveStates)
    .values({
      userId,
      valence: 0.6,
      arousal: 0.3,
      confidence: 0.5,
      energy: 0.7,
      social: 0.4,
      curiosity: 0.6,
    })
    .onConflictDoNothing();

  console.log('Seed complete.');
}

seed().catch(console.error);
