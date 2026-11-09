import {
  OAuthResourceServer,
  type AuthorizationServerBinding,
  type OAuthResourceTokenValidator,
} from '@cloudflare/workers-oauth-provider';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { AUDIT_RETENTION_SECONDS, audit } from './audit';
import { createGateway, type GrantProps } from './gateway';
import { TOOLS_READ } from './scopes';
import { UPSTREAMS, type Upstream } from './upstreams';

/**
 * The 2earl MCP gateway Worker (docs/DESIGN.md):
 * - `https://mcp.2earl.com/mcp`: the MCP endpoint, behind login's tokens;
 * - its RFC 9728 metadata at `/.well-known/oauth-protected-resource/mcp`;
 * - `AccountEvents`: what login calls when an account is deleted or exported.
 */

const now = () => Math.floor(Date.now() / 1000);

/** Browser-based MCP clients send bearer tokens, never cookies, so any origin may call. */
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id, Last-Event-ID',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id, MCP-Protocol-Version',
  'Access-Control-Max-Age': '86400',
};

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function withHeaders(response: Response, headers: Record<string, string>): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(headers)) out.headers.set(name, value);
  return out;
}

/** What validates a token: login's binding in production, a stand-in in tests. */
export type ValidatorFor = (env: Env) => OAuthResourceTokenValidator<GrantProps>;

const loginValidator: ValidatorFor = (env) => {
  const login = env.AUTH_SERVER as unknown as AuthorizationServerBinding<GrantProps>;
  return (resource, token) => login.validateToken(resource, token);
};

/** The Worker's fetch, with its dependencies explicit (tests pass their own). */
export function createWorker(deps: {
  upstreams: readonly Upstream[];
  now: () => number;
  validator: ValidatorFor;
}) {
  const gateway = createGateway({ upstreams: deps.upstreams, now: deps.now });
  const resourceServers = new Map<string, OAuthResourceServer<Env, GrantProps>>();
  const resourceServer = (env: Env): OAuthResourceServer<Env, GrantProps> => {
    let server = resourceServers.get(env.RESOURCE);
    if (server) return server;
    server = new OAuthResourceServer<Env, GrantProps>({
      resourceMetadata: {
        resource: env.RESOURCE,
        authorization_servers: [env.AUTHORIZATION_SERVER],
        bearer_methods_supported: ['header'],
        resource_name: '2earl MCP gateway',
      },
      requiredScopes: [TOOLS_READ],
      validateToken: deps.validator,
      handler: gateway,
    });
    resourceServers.set(env.RESOURCE, server);
    return server;
  };

  return async (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (url.pathname === '/healthz') return withHeaders(new Response('ok'), SECURITY_HEADERS);
    if (url.pathname === '/') {
      return withHeaders(Response.redirect('https://2earl.com', 302), SECURITY_HEADERS);
    }
    const response = await resourceServer(env).fetch(request, env, ctx);
    return withHeaders(response, { ...SECURITY_HEADERS, ...CORS_HEADERS });
  };
}

const worker = createWorker({ upstreams: UPSTREAMS, now, validator: loginValidator });

/** Called by login only, over a Service Binding (2earl/login DESIGN §4.8). */
export class AccountEvents extends WorkerEntrypoint<Env> {
  /**
   * Deletes what the gateway holds about the user: its security-log entries are re-keyed to a
   * random ID, as login does. Idempotent; throws if the update fails, so login retries.
   */
  async deleteUser(userId: string): Promise<void> {
    const correlationId = `deleted:${crypto.randomUUID()}`;
    await this.env.DB.prepare('UPDATE audit_events SET actor_user_id = ? WHERE actor_user_id = ?')
      .bind(correlationId, userId)
      .run();
    await audit(this.env.DB, now(), 'user.deleted', { actorUserId: correlationId });
  }

  /** The user's part of "Download your data" on login.2earl.com. */
  async exportUser(userId: string): Promise<Record<string, unknown>> {
    const { results } = await this.env.DB.prepare(
      `SELECT at, event, client_id, detail FROM audit_events WHERE actor_user_id = ? ORDER BY at`,
    )
      .bind(userId)
      .all<{ at: number; event: string; client_id: string | null; detail: string | null }>();
    return {
      service: '2earl MCP gateway',
      securityLog: results.map((row) => ({
        at: new Date(row.at * 1000).toISOString(),
        event: row.event,
        app: row.client_id,
        detail: row.detail ? (JSON.parse(row.detail) as unknown) : null,
      })),
      notes: [
        'The gateway stores no tool arguments or results, and no credentials of yours.',
        'Security log entries are kept for 90 days.',
      ],
    };
  }
}

export default {
  fetch: worker,

  /** Daily: security-log entries older than 90 days. */
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await env.DB.prepare('DELETE FROM audit_events WHERE at < ?')
      .bind(now() - AUDIT_RETENTION_SECONDS)
      .run();
  },
} satisfies ExportedHandler<Env>;
