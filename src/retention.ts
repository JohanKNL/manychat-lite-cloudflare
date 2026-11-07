const DEFAULT_RETENTION_DAYS = 30;

// RETENTION_DAYS: whole days to keep comments and DMs (usernames, comment text),
// "0" keeps everything. A missing or invalid value falls back to the default.
export function retentionDays(value: string | undefined): number {
  const days = Number(value?.trim());
  return value?.trim() && Number.isInteger(days) && days >= 0 ? days : DEFAULT_RETENTION_DAYS;
}

export async function deleteOldEvents(db: D1Database, days: number, now = Date.now()): Promise<{ comments: number; messages: number }> {
  if (days === 0) return { comments: 0, messages: 0 };

  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
  const comments = await db.prepare("DELETE FROM comment_events WHERE received_at < ?").bind(cutoff).run();
  const messages = await db.prepare("DELETE FROM message_events WHERE received_at < ?").bind(cutoff).run();
  return { comments: comments.meta.changes ?? 0, messages: messages.meta.changes ?? 0 };
}
