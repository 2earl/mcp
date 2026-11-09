/** The gateway's security log (docs/DESIGN.md §8): events and names, never tool arguments or results. */

export type AuditEvent =
  | 'tool.called'
  | 'tool.denied'
  | 'tool.failed'
  | 'tool.added'
  | 'tool.changed'
  | 'tool.held'
  | 'prompt.got'
  | 'prompt.denied'
  | 'prompt.failed'
  | 'user.deleted';

export const AUDIT_RETENTION_SECONDS = 90 * 24 * 60 * 60;

export async function audit(
  db: D1Database,
  now: number,
  event: AuditEvent,
  fields: {
    actorUserId?: string | null;
    clientId?: string | null;
    detail?: Record<string, string | number | boolean | null>;
  } = {},
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO audit_events (id, at, event, actor_user_id, client_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      crypto.randomUUID(),
      now,
      event,
      fields.actorUserId ?? null,
      fields.clientId ?? null,
      fields.detail ? JSON.stringify(fields.detail) : null,
    )
    .run();
}
