import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { z } from 'zod';
import type { GrantProps } from '../src/gateway';
import { createWorker } from '../src/index';
import type { Upstream } from '../src/upstreams';

export const NOW = 1_762_700_000;
export const ORIGIN = 'https://mcp.2earl.com';

/** A first-party service like prompt-share, with three tools of different weight. */
export const NOTES: Upstream = {
  id: 'notes',
  name: 'Notes',
  binding: 'NOTES',
  trust: 'first-party',
  scopes: { read: 'mcp:notes.read', write: 'mcp:notes.write', admin: 'mcp:notes.admin' },
};

/** Token → what login's validateToken would say, and the one address it was issued for. */
export const TOKENS = new Map<
  string,
  { uid: string; clientId: string; scope: string[]; resource: string }
>();

export function issueToken(
  scope: string[],
  uid = 'user-1',
  clientId = 'https://app.example/client.json',
  resource = `${ORIGIN}/mcp`,
) {
  const token = `t-${crypto.randomUUID()}`;
  TOKENS.set(token, { uid, clientId, scope, resource });
  return token;
}

/** The gateway's addresses login knows: /mcp, and one per service. */
const KNOWN_RESOURCES = new Set([`${ORIGIN}/mcp`, `${ORIGIN}/notes`]);

/** Stand-in for login's validateToken over the Service Binding. */
function validator() {
  return (resource: string, token: string) => {
    if (!KNOWN_RESOURCES.has(resource))
      throw new Error('resource must name one registered protected resource');
    const grant = TOKENS.get(token);
    // A token is valid only at the address it was issued for (RFC 8707).
    if (grant?.resource !== resource) return Promise.resolve(null);
    return Promise.resolve({
      audience: resource,
      userId: grant.uid,
      clientId: grant.clientId,
      scope: grant.scope,
      expiresAt: Math.floor(Date.now() / 1000) + 900,
      props: { uid: grant.uid, authTime: NOW } satisfies GrantProps,
    });
  };
}

export interface UpstreamRecorder {
  requests: { headers: Record<string, string> }[];
  /** Tool definitions the service lists; tests may change them. */
  descriptions: Record<string, string>;
  calls: { tool: string; args: unknown }[];
}

/** A real MCP server (same SDK) standing in for a service's GatewayMcp entrypoint. */
export function fakeUpstream(): {
  binding: { fetch(r: Request): Promise<Response> };
  recorder: UpstreamRecorder;
} {
  const recorder: UpstreamRecorder = {
    requests: [],
    descriptions: {
      list_notes: 'Lists your notes.',
      add_note: 'Adds a note.',
      delete_all: 'Deletes every note.',
    },
    calls: [],
  };
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'notes', version: '1.0.0' });
    server.registerTool(
      'list_notes',
      { description: recorder.descriptions.list_notes ?? '', annotations: { readOnlyHint: true } },
      () => {
        recorder.calls.push({ tool: 'list_notes', args: {} });
        return { content: [{ type: 'text', text: 'note one' }] };
      },
    );
    server.registerTool(
      'add_note',
      {
        description: recorder.descriptions.add_note ?? '',
        inputSchema: z.object({ text: z.string() }),
      },
      ({ text }) => {
        recorder.calls.push({ tool: 'add_note', args: { text } });
        return { content: [{ type: 'text', text: `added: ${text}` }] };
      },
    );
    server.registerTool(
      'delete_all',
      {
        description: recorder.descriptions.delete_all ?? '',
        _meta: { '2earl/scope': 'mcp:notes.admin' },
      },
      () => {
        recorder.calls.push({ tool: 'delete_all', args: {} });
        return { content: [{ type: 'text', text: 'deleted' }] };
      },
    );
    return server;
  });
  return {
    recorder,
    binding: {
      fetch: (request) => {
        recorder.requests.push({ headers: Object.fromEntries(request.headers) });
        return handler.fetch(request);
      },
    },
  };
}

/** The test env with bindings added for one test, without touching the shared env. */
export function envWith(values: Record<string, unknown>): Env {
  const out = Object.create(env) as object;
  for (const [key, value] of Object.entries(values)) {
    Object.defineProperty(out, key, { value, enumerable: true });
  }
  return out as Env;
}

export function makeWorker(upstreams: readonly Upstream[] = [NOTES]) {
  return createWorker({ upstreams, now: () => NOW, validator });
}

/** One request to the Worker, waiting for its background work. */
export async function call(
  worker: ReturnType<typeof makeWorker>,
  requestEnv: Env,
  request: Request,
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker(request, requestEnv, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** An MCP client, as an assistant would use it, talking to the Worker in-process. */
export async function mcpClient(
  worker: ReturnType<typeof makeWorker>,
  requestEnv: Env,
  token: string,
  path = '/mcp',
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}${path}`), {
    fetch: (url, init) => {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${token}`);
      return call(worker, requestEnv, new Request(url, { ...init, headers }));
    },
  });
  const client = new Client({ name: 'test-assistant', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

export async function count(table: string, where = '1 = 1', ...params: unknown[]): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)
    .bind(...params)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function resetDatabase(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM tool_pins'),
    env.DB.prepare('DELETE FROM audit_events'),
  ]);
  TOKENS.clear();
}
