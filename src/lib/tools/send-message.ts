// Send message tool — direct API calls to messaging platforms

export interface SendMessageOutput {
  success: boolean;
  channel: string;
  recipient: string;
  message: string;
}

async function sendTelegram(recipient: string, text: string): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) throw new Error('TELEGRAM_BOT_TOKEN not configured.');

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: recipient, text }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Telegram API error (${res.status}): ${detail || res.statusText}`);
  }
}

async function sendSlack(recipient: string, text: string): Promise<void> {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) throw new Error('SLACK_BOT_TOKEN not configured.');

  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${botToken}`,
    },
    body: JSON.stringify({ channel: recipient, text }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Slack API error (${res.status}): ${detail || res.statusText}`);
  }
}

async function sendDiscord(recipient: string, text: string): Promise<void> {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) throw new Error('DISCORD_BOT_TOKEN not configured.');

  const res = await fetch(`https://discord.com/api/v10/channels/${recipient}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bot ${botToken}`,
    },
    body: JSON.stringify({ content: text }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Discord API error (${res.status}): ${detail || res.statusText}`);
  }
}

export async function sendChannelMessage(params: {
  channel: 'telegram' | 'slack' | 'discord' | 'whatsapp';
  recipient: string;
  text: string;
}): Promise<SendMessageOutput> {
  switch (params.channel) {
    case 'telegram':
      await sendTelegram(params.recipient, params.text);
      break;
    case 'slack':
      await sendSlack(params.recipient, params.text);
      break;
    case 'discord':
      await sendDiscord(params.recipient, params.text);
      break;
    case 'whatsapp':
      throw new Error('WhatsApp sending is not configured for voice.');
    default:
      throw new Error(`Unknown channel: ${params.channel}`);
  }

  return {
    success: true,
    channel: params.channel,
    recipient: params.recipient,
    message: `Message sent via ${params.channel}`,
  };
}
