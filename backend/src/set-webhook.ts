import 'dotenv/config';

const botToken = process.env.BOT_TOKEN ?? '';
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
const webhookUrl = process.env.TELEGRAM_WEBHOOK_URL ?? '';
const apiBaseUrl = (process.env.TELEGRAM_API_BASE_URL ?? 'https://api.telegram.org').replace(/\/$/, '');

if (!botToken || !webhookSecret || !webhookUrl) {
  throw new Error('Set BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and TELEGRAM_WEBHOOK_URL in backend/.env');
}

const response = await fetch(`${apiBaseUrl}/bot${botToken}/setWebhook`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ['channel_post', 'edited_channel_post'],
    drop_pending_updates: false
  })
});
const result = await response.json() as { ok: boolean; description?: string };
if (!response.ok || !result.ok) throw new Error(result.description ?? `setWebhook failed (${response.status})`);
console.log(`Telegram webhook registered: ${webhookUrl}`);
