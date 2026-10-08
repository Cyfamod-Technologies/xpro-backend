import axios from 'axios';

const DISCORD_MESSAGE_LIMIT = 1900;

export async function discordAlert(message: string) {
  const webhookUrl =
    process.env.DISCORD_WEBHOOK_URL || process.env.DISCORD_ALERT_WEBHOOK_URL;

  if (!webhookUrl) return;

  const content =
    message.length > DISCORD_MESSAGE_LIMIT
      ? `${message.slice(0, DISCORD_MESSAGE_LIMIT)}\n...truncated`
      : message;

  try {
    await axios.post(webhookUrl, { content });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error('Failed to send alert to Discord:', message);
  }
}
