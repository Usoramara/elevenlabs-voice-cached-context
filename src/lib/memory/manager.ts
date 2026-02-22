import { getDb } from '@/db';
import { memories } from '@/db/schema';
import { eq, desc, sql, and } from 'drizzle-orm';
import { embed } from './embeddings';

export interface MemoryInput {
  userId: string;
  type: 'episodic' | 'semantic' | 'procedural' | 'person';
  content: string;
  significance: number;
  tags?: string[];
}

export interface MemoryResult {
  id: string;
  type: string;
  content: string;
  significance: number;
  tags: string[] | null;
  similarity?: number;
  createdAt: Date;
}

/**
 * Save a memory with its vector embedding.
 */
export async function saveMemoryWithEmbedding(input: MemoryInput): Promise<string> {
  const db = getDb();
  const embedding = await embed(input.content);

  const [row] = await db.insert(memories).values({
    userId: input.userId,
    type: input.type,
    content: input.content,
    significance: input.significance,
    tags: input.tags ?? [],
    embedding,
  }).returning({ id: memories.id });

  return row.id;
}

/**
 * Semantic search using pgvector cosine similarity.
 * Returns memories ranked by similarity to the query.
 */
export async function searchMemories(
  userId: string,
  query: string,
  limit = 10,
  minSimilarity = 0.3,
): Promise<MemoryResult[]> {
  const db = getDb();
  const queryEmbedding = await embed(query);

  // pgvector cosine distance: 1 - (a <=> b) = similarity
  const similarity = sql<number>`1 - (${memories.embedding} <=> ${JSON.stringify(queryEmbedding)}::vector)`;

  const results = await db
    .select({
      id: memories.id,
      type: memories.type,
      content: memories.content,
      significance: memories.significance,
      tags: memories.tags,
      createdAt: memories.createdAt,
      similarity,
    })
    .from(memories)
    .where(
      and(
        eq(memories.userId, userId),
        sql`1 - (${memories.embedding} <=> ${JSON.stringify(queryEmbedding)}::vector) > ${minSimilarity}`,
      ),
    )
    .orderBy(sql`${memories.embedding} <=> ${JSON.stringify(queryEmbedding)}::vector`)
    .limit(limit);

  return results;
}

/**
 * Get recent memories for a user (no semantic search, just chronological).
 */
export async function getRecentMemories(
  userId: string,
  limit = 20,
): Promise<MemoryResult[]> {
  const db = getDb();

  return db
    .select({
      id: memories.id,
      type: memories.type,
      content: memories.content,
      significance: memories.significance,
      tags: memories.tags,
      createdAt: memories.createdAt,
    })
    .from(memories)
    .where(eq(memories.userId, userId))
    .orderBy(desc(memories.createdAt))
    .limit(limit);
}
