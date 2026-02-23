// Browser automation tool
// Uses Browserless.io in production, local Playwright in development

export interface BrowserNavigateOutput {
  url: string;
  title: string;
  snapshot: string;
  status: number;
}

export interface BrowserScreenshotOutput {
  image_base64: string;
  format: string;
}

export interface BrowserActOutput {
  action: string;
  success: boolean;
  message: string;
}

// Per-user browser sessions
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sessions = new Map<string, { page: any; browser: any }>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getPlaywright(): Promise<{ chromium: any }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await (Function('return import("playwright-core")')() as Promise<{ chromium: any }>);
  } catch {
    throw new Error('playwright-core not installed. Browser tools are unavailable.');
  }
}

async function getBrowserEndpoint(): Promise<string | null> {
  const browserlessKey = process.env.BROWSERLESS_API_KEY;
  if (browserlessKey) {
    return `wss://chrome.browserless.io?token=${browserlessKey}`;
  }
  return null;
}

async function ensureSession(userId?: string) {
  const sessionKey = userId ?? 'default';

  if (sessions.has(sessionKey)) {
    return sessions.get(sessionKey)!;
  }

  const pw = await getPlaywright();
  const endpoint = await getBrowserEndpoint();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;
  if (endpoint) {
    browser = await pw.chromium.connectOverCDP(endpoint);
  } else {
    browser = await pw.chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  const session = { page, browser };
  sessions.set(sessionKey, session);

  setTimeout(async () => {
    sessions.delete(sessionKey);
    try {
      await browser.close();
    } catch { /* ignore */ }
  }, 5 * 60_000);

  return session;
}

export async function browserNavigate(params: {
  url: string;
  userId?: string;
}): Promise<BrowserNavigateOutput> {
  const { page } = await ensureSession(params.userId);

  const response = await page.goto(params.url, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });

  const title = await page.title();

  let snapshot: string;
  try {
    snapshot = await page.innerText('body');
    if (snapshot.length > 10_000) {
      snapshot = snapshot.slice(0, 10_000) + '\n... [truncated]';
    }
  } catch {
    snapshot = 'Unable to extract page text.';
  }

  return {
    url: params.url,
    title,
    snapshot,
    status: response?.status() ?? 0,
  };
}

export async function browserScreenshot(params: {
  userId?: string;
}): Promise<BrowserScreenshotOutput> {
  const { page } = await ensureSession(params.userId);

  const buffer = await page.screenshot({ type: 'png', fullPage: false });
  return {
    image_base64: Buffer.from(buffer).toString('base64'),
    format: 'image/png',
  };
}

export async function browserAct(params: {
  action: string;
  selector?: string;
  value?: string;
  userId?: string;
}): Promise<BrowserActOutput> {
  const { page } = await ensureSession(params.userId);

  switch (params.action) {
    case 'click':
      if (!params.selector) throw new Error('selector required for click action');
      await page.click(params.selector);
      return { action: 'click', success: true, message: `Clicked: ${params.selector}` };

    case 'type':
      if (!params.selector) throw new Error('selector required for type action');
      if (!params.value) throw new Error('value required for type action');
      await page.fill(params.selector, params.value);
      return { action: 'type', success: true, message: `Typed "${params.value}" into ${params.selector}` };

    case 'scroll':
      await page.evaluate(
        (dir: string) => window.scrollBy(0, dir === 'up' ? -500 : 500),
        params.value ?? 'down',
      );
      return { action: 'scroll', success: true, message: `Scrolled ${params.value ?? 'down'}` };

    case 'select':
      if (!params.selector) throw new Error('selector required for select action');
      if (!params.value) throw new Error('value required for select action');
      await page.selectOption(params.selector, params.value);
      return { action: 'select', success: true, message: `Selected "${params.value}" in ${params.selector}` };

    case 'hover':
      if (!params.selector) throw new Error('selector required for hover action');
      await page.hover(params.selector);
      return { action: 'hover', success: true, message: `Hovered over ${params.selector}` };

    default:
      throw new Error(`Unknown action: ${params.action}. Supported: click, type, scroll, select, hover.`);
  }
}
