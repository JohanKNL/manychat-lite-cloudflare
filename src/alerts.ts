type AlertEnv = Pick<Cloudflare.Env, "DB"> & {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
};

const HOUR = 60 * 60 * 1000;

/**
 * Sends one Telegram message per kind of problem per cooldown, so a burst of
 * failures is a single alert. Does nothing without the Telegram secrets and
 * never throws: an alert must not turn a failed DM into a second failure.
 * Messages carry no usernames or comment text.
 */
export async function sendAlert(env: AlertEnv, kind: string, text: string, cooldownMs = HOUR, now = Date.now()): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return;

  try {
    const key = `alert:${kind}`;
    const last = await env.DB.prepare("SELECT value FROM automation_settings WHERE key = ?").bind(key).first<{ value: string }>();
    const lastSentAt = Number(last?.value);
    if (Number.isFinite(lastSentAt) && now - lastSentAt < cooldownMs) return;

    await env.DB.prepare(
      `INSERT INTO automation_settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(key, String(now), new Date(now).toISOString()).run();

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 1000), disable_web_page_preview: true })
    });
    if (!response.ok) {
      console.error(JSON.stringify({ level: "error", msg: "alert_not_sent", kind, status: response.status }));
    }
  } catch {
    console.error(JSON.stringify({ level: "error", msg: "alert_not_sent", kind }));
  }
}
