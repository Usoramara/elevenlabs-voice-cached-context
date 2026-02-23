// Tool executor — dispatches tool calls with per-tool timeout wrapping

import { webSearch } from './web-search';
import { webFetch, webFetchEnhanced } from './web-fetch';
import { generateImage } from './image-gen';
import { understandImage } from './image-understand';
import { readPdf } from './pdf-read';
import { scheduleTask, listSchedules, cancelSchedule } from './schedule';
import { sendChannelMessage } from './send-message';
import { browserNavigate, browserScreenshot, browserAct } from './browser';
import { executeCode } from './code-exec';
import { sendEmail } from './email';
import { getWeather } from './weather';
import { searchMemories } from '@/lib/memory/manager';
import { TOOL_TIMEOUTS, DEFAULT_TOOL_TIMEOUT } from '@/lib/voice/config';

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  userId?: string;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

async function memorySearch(params: {
  query: string;
  userId?: string;
}): Promise<{ results: Array<{ content: string; type: string; similarity?: number }>; count: number }> {
  if (!params.userId) {
    return { results: [], count: 0 };
  }
  const memories = await searchMemories(params.userId, params.query, 10);
  return {
    results: memories.map(m => ({
      content: m.content,
      type: m.type,
      similarity: m.similarity,
    })),
    count: memories.length,
  };
}

/**
 * Execute a tool call with per-tool timeout wrapping.
 * On timeout, returns a graceful error rather than hanging.
 */
export async function executeTool(call: ToolCall): Promise<ToolResult> {
  const timeout = TOOL_TIMEOUTS[call.name] ?? DEFAULT_TOOL_TIMEOUT;

  try {
    const result = await Promise.race([
      executeToolInner(call),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('TOOL_TIMEOUT')), timeout),
      ),
    ]);
    return result;
  } catch (error) {
    if (error instanceof Error && error.message === 'TOOL_TIMEOUT') {
      return {
        tool_use_id: call.id,
        content: JSON.stringify({ error: 'Verktøyet tok for lang tid. Prøv igjen senere.' }),
        is_error: true,
      };
    }
    const message =
      error instanceof Error ? error.message : 'Tool execution failed';
    return {
      tool_use_id: call.id,
      content: JSON.stringify({ error: message }),
      is_error: true,
    };
  }
}

async function executeToolInner(call: ToolCall): Promise<ToolResult> {
  let result: unknown;

  switch (call.name) {
    case 'web_search':
      result = await webSearch({
        query: call.input.query as string,
        count: call.input.count as number | undefined,
        provider: call.input.provider as 'brave' | 'perplexity' | 'grok' | undefined,
      });
      break;

    case 'web_fetch':
      result = call.input.use_firecrawl
        ? await webFetchEnhanced({
            url: call.input.url as string,
            max_chars: call.input.max_chars as number | undefined,
            use_firecrawl: true,
          })
        : await webFetch({
            url: call.input.url as string,
            max_chars: call.input.max_chars as number | undefined,
          });
      break;

    case 'memory_search':
      result = await memorySearch({
        query: call.input.query as string,
        userId: call.userId,
      });
      break;

    case 'generate_image':
      result = await generateImage({
        prompt: call.input.prompt as string,
        size: call.input.size as '1024x1024' | '1024x1792' | '1792x1024' | undefined,
        quality: call.input.quality as 'standard' | 'hd' | undefined,
        style: call.input.style as 'vivid' | 'natural' | undefined,
      });
      break;

    case 'understand_image':
      result = await understandImage({
        url: call.input.url as string,
        question: call.input.question as string | undefined,
      });
      break;

    case 'read_pdf':
      result = await readPdf({
        url: call.input.url as string,
        max_pages: call.input.max_pages as number | undefined,
      });
      break;

    case 'schedule_task':
      result = await scheduleTask({
        description: call.input.description as string,
        run_at: call.input.run_at as string | undefined,
        cron: call.input.cron as string | undefined,
        timezone: call.input.timezone as string | undefined,
        userId: call.userId,
      });
      break;

    case 'list_schedules':
      result = await listSchedules({ userId: call.userId });
      break;

    case 'cancel_schedule':
      result = await cancelSchedule({
        schedule_id: call.input.schedule_id as string,
        userId: call.userId,
      });
      break;

    case 'send_message':
      result = await sendChannelMessage({
        channel: call.input.channel as 'telegram' | 'slack' | 'discord' | 'whatsapp',
        recipient: call.input.recipient as string,
        text: call.input.text as string,
      });
      break;

    case 'browser_navigate':
      result = await browserNavigate({
        url: call.input.url as string,
        userId: call.userId,
      });
      break;

    case 'browser_screenshot':
      result = await browserScreenshot({
        userId: call.userId,
      });
      break;

    case 'browser_act':
      result = await browserAct({
        action: call.input.action as string,
        selector: call.input.selector as string | undefined,
        value: call.input.value as string | undefined,
        userId: call.userId,
      });
      break;

    case 'execute_code':
      result = await executeCode({
        code: call.input.code as string,
        language: call.input.language as 'javascript' | 'typescript' | 'python' | 'bash' | undefined,
      });
      break;

    case 'send_email':
      result = await sendEmail({
        to: call.input.to as string,
        subject: call.input.subject as string,
        body: call.input.body as string,
        html: call.input.html as boolean | undefined,
      });
      break;

    case 'get_weather':
      result = await getWeather({
        location: call.input.location as string,
      });
      break;

    default:
      return {
        tool_use_id: call.id,
        content: JSON.stringify({ error: `Unknown tool: ${call.name}` }),
        is_error: true,
      };
  }

  return {
    tool_use_id: call.id,
    content: JSON.stringify(result),
  };
}
