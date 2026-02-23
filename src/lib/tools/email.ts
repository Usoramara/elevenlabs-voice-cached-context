// Email tool — sends emails via Gmail API or Resend

export interface SendEmailOutput {
  success: boolean;
  message_id?: string;
  to: string;
  subject: string;
}

async function sendViaGmailApi(params: {
  to: string;
  subject: string;
  body: string;
  html?: boolean;
}): Promise<SendEmailOutput> {
  const accessToken = process.env.GMAIL_ACCESS_TOKEN;
  if (!accessToken) throw new Error('GMAIL_ACCESS_TOKEN not configured.');

  const contentType = params.html ? 'text/html' : 'text/plain';
  const rawEmail = [
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    `Content-Type: ${contentType}; charset=utf-8`,
    '',
    params.body,
  ].join('\r\n');

  const encodedEmail = Buffer.from(rawEmail)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ raw: encodedEmail }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Gmail API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = await res.json() as { id?: string };
  return {
    success: true,
    message_id: data.id,
    to: params.to,
    subject: params.subject,
  };
}

async function sendViaResend(params: {
  to: string;
  subject: string;
  body: string;
  html?: boolean;
}): Promise<SendEmailOutput> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not configured.');

  const fromEmail = process.env.RESEND_FROM_EMAIL ?? 'wybe@resend.dev';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: fromEmail,
      to: params.to,
      subject: params.subject,
      [params.html ? 'html' : 'text']: params.body,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = await res.json() as { id?: string };
  return {
    success: true,
    message_id: data.id,
    to: params.to,
    subject: params.subject,
  };
}

export async function sendEmail(params: {
  to: string;
  subject: string;
  body: string;
  html?: boolean;
}): Promise<SendEmailOutput> {
  if (!params.to.includes('@')) {
    throw new Error(`Invalid email address: ${params.to}`);
  }

  if (process.env.RESEND_API_KEY) {
    return sendViaResend(params);
  }
  if (process.env.GMAIL_ACCESS_TOKEN) {
    return sendViaGmailApi(params);
  }

  throw new Error(
    'No email provider configured. Set RESEND_API_KEY or GMAIL_ACCESS_TOKEN.'
  );
}
