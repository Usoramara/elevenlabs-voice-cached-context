// Web fetch with Readability extraction

const DEFAULT_MAX_CHARS = 20_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const TIMEOUT_MS = 15_000;
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function isBlockedUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();

    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal')
    ) {
      return true;
    }

    const parts = hostname.split('.');
    if (parts.length === 4 && parts.every((p) => /^\d+$/.test(p))) {
      const first = parseInt(parts[0]);
      const second = parseInt(parts[1]);
      if (first === 10) return true;
      if (first === 172 && second >= 16 && second <= 31) return true;
      if (first === 192 && second === 168) return true;
      if (first === 169 && second === 254) return true;
    }

    if (!['http:', 'https:'].includes(url.protocol)) {
      return true;
    }

    return false;
  } catch {
    return true;
  }
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export interface WebFetchOutput {
  url: string;
  title?: string;
  text: string;
  contentType?: string;
  truncated: boolean;
}

export async function webFetch(params: {
  url: string;
  max_chars?: number;
}): Promise<WebFetchOutput> {
  if (isBlockedUrl(params.url)) {
    throw new Error('URL blocked: cannot fetch internal/private addresses.');
  }

  const maxChars = Math.max(100, params.max_chars ?? DEFAULT_MAX_CHARS);

  const res = await fetch(params.url, {
    method: 'GET',
    headers: {
      Accept: 'text/html, application/json, text/plain;q=0.9, */*;q=0.1',
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  });

  if (!res.ok) {
    throw new Error(`Fetch failed (${res.status}): ${res.statusText}`);
  }

  const contentType = res.headers.get('content-type') ?? '';

  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error('No response body');
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (totalBytes < MAX_RESPONSE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    totalBytes += value.length;
  }
  reader.cancel();

  const body = new TextDecoder().decode(
    chunks.length === 1
      ? chunks[0]
      : new Uint8Array(
          chunks.reduce<number[]>((acc, c) => [...acc, ...c], []),
        ),
  );

  let text: string;
  let title: string | undefined;

  if (contentType.includes('text/html')) {
    try {
      const { Readability } = await import('@mozilla/readability');
      const { parseHTML } = await import('linkedom');
      const { document } = parseHTML(body);
      const reader = new Readability(document, { charThreshold: 0 });
      const parsed = reader.parse();
      if (parsed?.textContent) {
        text = parsed.textContent.replace(/\s+/g, ' ').trim();
        title = parsed.title || undefined;
      } else {
        text = stripTags(body);
        const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        title = titleMatch ? stripTags(titleMatch[1]) : undefined;
      }
    } catch {
      text = stripTags(body);
      const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      title = titleMatch ? stripTags(titleMatch[1]) : undefined;
    }
  } else if (contentType.includes('application/json')) {
    try {
      text = JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      text = body;
    }
  } else {
    text = body;
  }

  const truncated = text.length > maxChars;
  if (truncated) {
    text = text.slice(0, maxChars);
  }

  return {
    url: params.url,
    title,
    text,
    contentType: contentType.split(';')[0]?.trim() || undefined,
    truncated,
  };
}

async function firecrawlFetch(url: string, maxChars: number): Promise<WebFetchOutput> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY not configured.');

  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      url,
      formats: ['markdown'],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Firecrawl API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = await res.json() as {
    success: boolean;
    data?: { markdown?: string; metadata?: { title?: string } };
  };

  if (!data.success || !data.data?.markdown) {
    throw new Error('Firecrawl returned no content');
  }

  let text = data.data.markdown;
  const truncated = text.length > maxChars;
  if (truncated) text = text.slice(0, maxChars);

  return {
    url,
    title: data.data.metadata?.title,
    text,
    contentType: 'text/markdown',
    truncated,
  };
}

export async function webFetchEnhanced(params: {
  url: string;
  max_chars?: number;
  use_firecrawl?: boolean;
}): Promise<WebFetchOutput> {
  const maxChars = Math.max(100, params.max_chars ?? DEFAULT_MAX_CHARS);

  if (params.use_firecrawl && process.env.FIRECRAWL_API_KEY) {
    return firecrawlFetch(params.url, maxChars);
  }

  try {
    const result = await webFetch({ url: params.url, max_chars: params.max_chars });
    if (result.text.length < 100 && process.env.FIRECRAWL_API_KEY) {
      try {
        return await firecrawlFetch(params.url, maxChars);
      } catch {
        return result;
      }
    }
    return result;
  } catch (err) {
    if (process.env.FIRECRAWL_API_KEY) {
      return firecrawlFetch(params.url, maxChars);
    }
    throw err;
  }
}
