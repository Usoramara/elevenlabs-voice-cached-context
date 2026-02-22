import { pipeline } from '@huggingface/transformers';

const MODEL = 'Xenova/all-MiniLM-L6-v2'; // 384 dimensions, runs locally
export const EMBEDDING_DIMENSIONS = 384;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extractor: any = null;

async function getExtractor() {
  if (!extractor) {
    extractor = await pipeline('feature-extraction', MODEL, {
      dtype: 'fp32',
    });
  }
  return extractor;
}

export async function embed(text: string): Promise<number[]> {
  const ext = await getExtractor();
  const output = await ext(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data as Float32Array);
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (texts.length === 1) return [await embed(texts[0])];

  const results: number[][] = [];
  for (const text of texts) {
    results.push(await embed(text));
  }
  return results;
}
