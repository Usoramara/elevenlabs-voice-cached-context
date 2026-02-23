// Sandboxed code execution tool
// Uses E2B for cloud sandboxes, with local eval fallback for simple JS

export interface CodeExecOutput {
  stdout: string;
  stderr: string;
  exit_code: number;
  language: string;
  execution_time_ms: number;
  provider: string;
}

const MAX_OUTPUT_CHARS = 10_000;
const TIMEOUT_MS = 30_000;

async function e2bExecute(code: string, language: string): Promise<CodeExecOutput> {
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) throw new Error('E2B_API_KEY not configured.');

  const templateMap: Record<string, string> = {
    javascript: 'nodejs',
    typescript: 'nodejs',
    python: 'python',
    bash: 'bash',
  };

  const template = templateMap[language] ?? 'nodejs';

  const execCode = language === 'typescript'
    ? `const {execSync} = require('child_process'); const fs = require('fs'); fs.writeFileSync('/tmp/script.ts', ${JSON.stringify(code)}); console.log(execSync('npx tsx /tmp/script.ts', {encoding: 'utf-8'}));`
    : code;

  const start = Date.now();

  const res = await fetch('https://api.e2b.dev/sandboxes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({
      template,
      timeout: TIMEOUT_MS / 1000,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`E2B API error (${res.status}): ${await res.text()}`);
  }

  const sandbox = await res.json() as { sandboxId: string };

  const execRes = await fetch(`https://api.e2b.dev/sandboxes/${sandbox.sandboxId}/code/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({
      code: execCode,
      language: template === 'nodejs' ? 'javascript' : language,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const execData = await execRes.json() as {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  };

  return {
    stdout: (execData.stdout ?? '').slice(0, MAX_OUTPUT_CHARS),
    stderr: (execData.stderr ?? '').slice(0, MAX_OUTPUT_CHARS),
    exit_code: execData.exitCode ?? 0,
    language,
    execution_time_ms: Date.now() - start,
    provider: 'e2b',
  };
}

async function localJsExecute(code: string): Promise<CodeExecOutput> {
  const start = Date.now();

  const logs: string[] = [];
  const errors: string[] = [];

  const mockConsole = {
    log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => errors.push(args.map(String).join(' ')),
    warn: (...args: unknown[]) => logs.push(`[warn] ${args.map(String).join(' ')}`),
    info: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
  };

  try {
    const fn = new Function('console', 'Math', 'JSON', 'Date', 'Array', 'Object', 'String', 'Number', 'Boolean', 'RegExp', 'Map', 'Set', 'Promise',
      `"use strict";\n${code}`
    );
    const result = fn(mockConsole, Math, JSON, Date, Array, Object, String, Number, Boolean, RegExp, Map, Set, Promise);
    if (result !== undefined) {
      logs.push(String(result));
    }
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  }

  return {
    stdout: logs.join('\n').slice(0, MAX_OUTPUT_CHARS),
    stderr: errors.join('\n').slice(0, MAX_OUTPUT_CHARS),
    exit_code: errors.length > 0 ? 1 : 0,
    language: 'javascript',
    execution_time_ms: Date.now() - start,
    provider: 'local',
  };
}

export async function executeCode(params: {
  code: string;
  language?: string;
}): Promise<CodeExecOutput> {
  const language = params.language ?? 'javascript';

  if (process.env.E2B_API_KEY) {
    return e2bExecute(params.code, language);
  }

  if (language === 'javascript' || language === 'typescript') {
    return localJsExecute(params.code);
  }

  throw new Error(
    `Code execution requires E2B_API_KEY for ${language}. Only JavaScript is available locally.`
  );
}
