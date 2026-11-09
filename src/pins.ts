import { audit } from './audit';
import { requiredScope } from './scopes';
import type { Upstream } from './upstreams';

/**
 * Tool pinning (docs/DESIGN.md §6.3). What an assistant sees of a tool (its description in
 * particular) can steer the model. Every tool's visible definition is hashed when first seen;
 * a change is offered at once and audited for a first-party service, and hidden until the owner
 * approves it for a third-party one.
 */

export interface UpstreamTool {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown> & { readOnlyHint?: boolean };
  _meta?: Record<string, unknown>;
}

/** JSON with sorted keys, so the hash doesn't depend on property order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  // As JSON.stringify does inside arrays: a missing value is null.
  return value === undefined ? 'null' : JSON.stringify(value);
}

export async function toolHash(upstream: Upstream, tool: UpstreamTool): Promise<string> {
  const visible = {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    scope: requiredScope(upstream, tool),
  };
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonical(visible)),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The tools of `upstream` that may be offered now. Records new and changed tools on the way. */
export async function approvedTools(
  db: D1Database,
  now: number,
  upstream: Upstream,
  tools: UpstreamTool[],
): Promise<UpstreamTool[]> {
  const { results } = await db
    .prepare('SELECT tool, hash, status FROM tool_pins WHERE upstream = ?')
    .bind(upstream.id)
    .all<{ tool: string; hash: string; status: 'approved' | 'pending' }>();
  const pins = new Map(results.map((row) => [row.tool, row]));
  const offered: UpstreamTool[] = [];

  for (const tool of tools) {
    const hash = await toolHash(upstream, tool);
    const pin = pins.get(tool.name);
    const firstParty = upstream.trust === 'first-party';

    if (!pin) {
      const status = firstParty ? 'approved' : 'pending';
      await db
        .prepare(
          `INSERT INTO tool_pins (upstream, tool, hash, status, first_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (upstream, tool) DO NOTHING`,
        )
        .bind(upstream.id, tool.name, hash, status, now, now)
        .run();
      await audit(db, now, firstParty ? 'tool.added' : 'tool.held', {
        detail: { upstream: upstream.id, tool: tool.name },
      });
      if (firstParty) offered.push(tool);
      continue;
    }

    if (pin.hash !== hash) {
      const status = firstParty ? 'approved' : 'pending';
      await db
        .prepare(
          'UPDATE tool_pins SET hash = ?, status = ?, updated_at = ? WHERE upstream = ? AND tool = ?',
        )
        .bind(hash, status, now, upstream.id, tool.name)
        .run();
      await audit(db, now, firstParty ? 'tool.changed' : 'tool.held', {
        detail: { upstream: upstream.id, tool: tool.name },
      });
      if (firstParty) offered.push(tool);
      continue;
    }

    if (pin.status === 'approved') offered.push(tool);
  }
  return offered;
}
