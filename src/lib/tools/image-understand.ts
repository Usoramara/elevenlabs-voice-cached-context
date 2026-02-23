// Image understanding tool using Claude Vision

import Anthropic from '@anthropic-ai/sdk';

export interface ImageUnderstandOutput {
  description: string;
  model: string;
}

export async function understandImage(params: {
  url: string;
  question?: string;
}): Promise<ImageUnderstandOutput> {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  });

  const prompt = params.question
    ? `Look at this image and answer: ${params.question}`
    : 'Describe this image in detail. Include what you see, any text, colors, composition, and context.';

  const urlLower = params.url.toLowerCase();
  let mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' = 'image/jpeg';
  if (urlLower.includes('.png')) mediaType = 'image/png';
  else if (urlLower.includes('.gif')) mediaType = 'image/gif';
  else if (urlLower.includes('.webp')) mediaType = 'image/webp';

  const isBase64 = params.url.startsWith('data:');

  const imageContent = isBase64
    ? {
        type: 'image' as const,
        source: {
          type: 'base64' as const,
          media_type: mediaType,
          data: params.url.split(',')[1] ?? params.url,
        },
      }
    : {
        type: 'image' as const,
        source: {
          type: 'url' as const,
          url: params.url,
        },
      };

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    messages: [
      {
        role: 'user',
        content: [
          imageContent,
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  return {
    description: text,
    model: 'claude-sonnet-4-20250514',
  };
}
