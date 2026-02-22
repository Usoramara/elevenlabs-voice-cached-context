-- Neon PostgreSQL setup for ElevenLabs Voice Pipeline
-- Run this in the Neon SQL Editor before pushing the Drizzle schema.

-- Enable pgvector extension (required for memory embeddings)
CREATE EXTENSION IF NOT EXISTS vector;

-- Verify it's active
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
