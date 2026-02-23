// Web search with multiple provider backends
// Providers: Brave (default), Perplexity Sonar, xAI Grok

const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const DEFAULT_COUNT = 5;
const MAX_COUNT = 10;
const TIMEOUT_MS = 15_000;

interface BraveSearchResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
}

export interface WebSearchResult {
  title: string;
  url: string;
  description: string;
  published?: string;
}

export interface WebSearchOutput {
  query: string;
  results: WebSearchResult[];
  count: number;
  provider: string;
}

async function braveSearch(query: string, count: number): Promise<WebSearchOutput> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) throw new Error('BRAVE_API_KEY not configured.');

  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));

  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Brave Search error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as BraveSearchResponse;
  const results = (data.web?.results ?? []).map((entry) => ({
    title: entry.title ?? '',
    url: entry.url ?? '',
    description: entry.description ?? '',
    published: entry.age || undefined,
  }));

  return { query, results, count: results.length, provider: 'brave' };
}

async function perplexitySearch(query: string, count: number): Promise<WebSearchOutput> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) throw new Error('PERPLEXITY_API_KEY not configured.');

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'sonar',
      messages: [{ role: 'user', content: query }],
      max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Perplexity API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
    citations?: string[];
  };

  const answer = data.choices?.[0]?.message?.content ?? '';
  const citations = data.citations ?? [];

  const results: WebSearchResult[] = citations.slice(0, count).map((url, i) => ({
    title: `Source ${i + 1}`,
    url,
    description: i === 0 ? answer : '',
  }));

  if (results.length === 0) {
    results.push({ title: 'Perplexity Answer', url: '', description: answer });
  }

  return { query, results, count: results.length, provider: 'perplexity' };
}

async function grokSearch(query: string, count: number): Promise<WebSearchOutput> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) throw new Error('XAI_API_KEY not configured.');

  const res = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'grok-3',
      messages: [
        { role: 'system', content: 'You are a search assistant. Provide factual, up-to-date information with sources. Format each result with a title, URL if known, and description.' },
        { role: 'user', content: query },
      ],
      search_parameters: { mode: 'auto' },
      max_tokens: 1024,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`xAI API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = await res.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  const answer = data.choices?.[0]?.message?.content ?? '';
  return {
    query,
    results: [{ title: 'Grok Search Result', url: '', description: answer }],
    count: 1,
    provider: 'grok',
  };
}

type SearchProvider = 'brave' | 'perplexity' | 'grok';

function resolveProvider(preferred?: SearchProvider): SearchProvider {
  if (preferred) {
    switch (preferred) {
      case 'perplexity': if (process.env.PERPLEXITY_API_KEY) return 'perplexity'; break;
      case 'grok': if (process.env.XAI_API_KEY) return 'grok'; break;
      case 'brave': if (process.env.BRAVE_API_KEY) return 'brave'; break;
    }
  }
  if (process.env.BRAVE_API_KEY) return 'brave';
  if (process.env.PERPLEXITY_API_KEY) return 'perplexity';
  if (process.env.XAI_API_KEY) return 'grok';
  throw new Error('No search provider configured. Set BRAVE_API_KEY, PERPLEXITY_API_KEY, or XAI_API_KEY.');
}

export async function webSearch(params: {
  query: string;
  count?: number;
  provider?: SearchProvider;
}): Promise<WebSearchOutput> {
  const count = Math.max(1, Math.min(MAX_COUNT, params.count ?? DEFAULT_COUNT));
  const provider = resolveProvider(params.provider);

  switch (provider) {
    case 'perplexity':
      return perplexitySearch(params.query, count);
    case 'grok':
      return grokSearch(params.query, count);
    case 'brave':
    default:
      return braveSearch(params.query, count);
  }
}
