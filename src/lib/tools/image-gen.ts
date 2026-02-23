// Image generation tool using OpenAI DALL-E API

export interface ImageGenOutput {
  url: string;
  revised_prompt?: string;
  model: string;
  size: string;
}

export async function generateImage(params: {
  prompt: string;
  size?: '1024x1024' | '1024x1792' | '1792x1024';
  quality?: 'standard' | 'hd';
  style?: 'vivid' | 'natural';
}): Promise<ImageGenOutput> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not configured. Image generation is unavailable.');
  }

  const size = params.size ?? '1024x1024';
  const quality = params.quality ?? 'standard';
  const style = params.style ?? 'vivid';

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'dall-e-3',
      prompt: params.prompt,
      n: 1,
      size,
      quality,
      style,
      response_format: 'url',
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`OpenAI Images API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = await res.json() as {
    data: Array<{ url: string; revised_prompt?: string }>;
  };

  const image = data.data[0];
  if (!image?.url) {
    throw new Error('No image URL returned from OpenAI');
  }

  return {
    url: image.url,
    revised_prompt: image.revised_prompt,
    model: 'dall-e-3',
    size,
  };
}
