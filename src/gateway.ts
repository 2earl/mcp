import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Server, createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import {
  insufficientScope,
  type OAuthResourceAuth,
  type OAuthResourceContext,
} from '@cloudflare/workers-oauth-provider';
import { audit } from './audit';
import { approvedTools, type UpstreamTool } from './pins';
import { TOOLS_READ, has, requiredScope, scopesFor } from './scopes';
import { prefixedName, splitName, type Upstream } from './upstreams';

/**
 * The MCP endpoint (docs/DESIGN.md §4): one stateless server per request that lists and calls
 * the tools of every service behind the gateway, plus `whoami`. Tokens are validated before this
 * runs (OAuthResourceServer); the token itself is never passed on.
 */

export const GATEWAY_INFO = { name: '2earl MCP gateway', version: '0.1.0' };
const UPSTREAM_TIMEOUT_MS = 25_000;

/** What login stores with each grant (2earl/login src/oauth.ts). */
export interface GrantProps {
  uid: string;
  authTime: number;
}

export interface Identity {
  uid: string;
  clientId: string;
  scope: string[];
}

export interface GatewayDeps {
  upstreams: readonly Upstream[];
  now: () => number;
}

/** A Service Binding to a service's `GatewayMcp` entrypoint (docs/UPSTREAM_CONTRACT.md). */
type UpstreamFetcher = { fetch(request: Request): Promise<Response> };

function fetcherFor(env: Env, upstream: Upstream): UpstreamFetcher | null {
  const binding = (env as unknown as Record<string, unknown>)[upstream.binding];
  return binding !== null &&
    typeof binding === 'object' &&
    typeof (binding as Partial<UpstreamFetcher>).fetch === 'function'
    ? (binding as UpstreamFetcher)
    : null;
}

/**
 * An MCP client for one service, for one request. The user's identity travels in headers the
 * service trusts because only Workers in this account can reach its entrypoint; the service is
 * told only its own scopes.
 */
async function connect(env: Env, upstream: Upstream, identity: Identity): Promise<Client> {
  const binding = fetcherFor(env, upstream);
  if (!binding) throw new Error(`no binding for ${upstream.id}`);
  const headers = {
    'X-2earl-User': identity.uid,
    'X-2earl-Client': identity.clientId,
    'X-2earl-Scopes': scopesFor(upstream, identity.scope).join(' '),
  };
  const transport = new StreamableHTTPClientTransport(
    new URL(`https://${upstream.id}.internal/mcp`),
    {
      fetch: (url, init) =>
        binding.fetch(
          new Request(url, {
            ...init,
            headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers },
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
          }),
        ),
      redirectPolicy: 'same-origin',
    },
  );
  const client = new Client({ name: GATEWAY_INFO.name, version: GATEWAY_INFO.version });
  await client.connect(transport);
  return client;
}

function identityOf(authInfo: AuthInfo | undefined): Identity {
  const extra = authInfo?.extra as { uid?: unknown } | undefined;
  if (!authInfo || typeof extra?.uid !== 'string') throw new Error('unauthenticated');
  return { uid: extra.uid, clientId: authInfo.clientId, scope: authInfo.scopes };
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

/** The tools a service offers this user now (pinned, approved), keyed by their gateway name. */
async function upstreamTools(
  env: Env,
  deps: GatewayDeps,
  upstream: Upstream,
  identity: Identity,
): Promise<{ client: Client; tools: UpstreamTool[] }> {
  const client = await connect(env, upstream, identity);
  const listed: UpstreamTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {});
    listed.push(...(page.tools as UpstreamTool[]));
    cursor = page.nextCursor;
  } while (cursor && listed.length < 500);
  return { client, tools: await approvedTools(env.DB, deps.now(), upstream, listed) };
}

const WHOAMI = {
  name: 'whoami',
  title: 'Who am I on 2earl',
  description:
    'Shows which 2earl account this assistant is using, which app it is, and what it may do through the 2earl MCP gateway.',
  inputSchema: { type: 'object' as const, properties: {} },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

// The low-level Server, not McpServer: the gateway passes services' tools through with their
// JSON Schemas as they are, which McpServer's schema-library registration can't express.
// eslint-disable-next-line @typescript-eslint/no-deprecated
function buildServer(env: Env, deps: GatewayDeps): Server {
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  const server = new Server(GATEWAY_INFO, { capabilities: { tools: {} } });

  server.setRequestHandler('tools/list', async (_request, ctx) => {
    const identity = identityOf(ctx.http?.authInfo);
    const tools: unknown[] = [WHOAMI];
    // One failing service doesn't hide the others.
    const lists = await Promise.allSettled(
      deps.upstreams.map(async (upstream) => {
        const { tools: offered } = await upstreamTools(env, deps, upstream, identity);
        return offered.map((tool) => ({
          ...tool,
          name: prefixedName(upstream, tool.name),
          title: `${upstream.name}: ${tool.title ?? tool.name}`,
        }));
      }),
    );
    for (const list of lists) if (list.status === 'fulfilled') tools.push(...list.value);
    return { tools } as never;
  });

  server.setRequestHandler('tools/call', async (request, ctx) => {
    const identity = identityOf(ctx.http?.authInfo);
    const name = request.params.name;

    if (name === WHOAMI.name) {
      const services = deps.upstreams.map((u) => ({
        service: u.name,
        permissions: scopesFor(u, identity.scope),
      }));
      return textResult(
        JSON.stringify(
          {
            account: identity.uid,
            app: identity.clientId,
            permissions: identity.scope,
            services,
          },
          null,
          2,
        ),
      );
    }

    const target = splitName(deps.upstreams, name);
    if (!target) return textResult(`Unknown tool: ${name}`, true);
    const { upstream, tool } = target;
    const now = deps.now();
    const log = (event: 'tool.called' | 'tool.failed' | 'tool.denied', outcome?: string) =>
      audit(env.DB, now, event, {
        actorUserId: identity.uid,
        clientId: identity.clientId,
        detail: { upstream: upstream.id, tool, ...(outcome ? { outcome } : {}) },
      });

    const { client, tools } = await upstreamTools(env, deps, upstream, identity);
    const definition = tools.find((t) => t.name === tool);
    if (!definition) return textResult(`Unknown tool: ${name}`, true);
    // Checked before this handler runs (scopeCheck); checked again here against the pinned tool.
    if (!has(identity.scope, requiredScope(upstream, definition), deps.upstreams)) {
      await log('tool.denied');
      return textResult(`This app may not use ${name}.`, true);
    }
    try {
      const result = await client.callTool({
        name: tool,
        arguments: request.params.arguments ?? {},
      });
      await log('tool.called', result.isError === true ? 'error' : 'ok');
      return result;
    } catch (error) {
      await log('tool.failed', error instanceof Error ? error.name : 'unknown');
      return textResult(`${upstream.name} couldn’t complete this request. Try again.`, true);
    }
  });

  return server;
}

/**
 * Before MCP handling: a `tools/call` for a tool whose scope the token lacks gets the HTTP
 * step-up challenge (403 insufficient_scope), so the client can ask the user for more.
 */
async function scopeCheck(
  request: Request,
  env: Env,
  deps: GatewayDeps,
  auth: OAuthResourceAuth,
  identity: Identity,
): Promise<Response | null> {
  if (request.method !== 'POST') return null;
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return null; // the MCP handler answers malformed requests
  }
  const message = body as { method?: unknown; params?: { name?: unknown } };
  if (!has(auth.scope, TOOLS_READ, deps.upstreams)) return insufficientScope(auth, [TOOLS_READ]);
  if (message.method !== 'tools/call' || typeof message.params?.name !== 'string') return null;
  const target = splitName(deps.upstreams, message.params.name);
  if (!target) return null;
  const { tools } = await upstreamTools(env, deps, target.upstream, identity);
  const definition = tools.find((t) => t.name === target.tool);
  if (!definition) return null;
  const needed = requiredScope(target.upstream, definition);
  return has(auth.scope, needed, deps.upstreams) ? null : insufficientScope(auth, [needed]);
}

export function createGateway(deps: GatewayDeps) {
  // One stateless handler; a fresh server per request (MCP 2026-07-28), legacy 2025 clients
  // served statelessly from the same definition.
  let handler: ReturnType<typeof createMcpHandler> | null = null;
  let handlerEnv: Env | null = null;

  return {
    async fetch(
      request: Request,
      env: Env,
      ctx: OAuthResourceContext<GrantProps>,
    ): Promise<Response> {
      const identity: Identity = {
        uid: ctx.props.uid,
        clientId: ctx.auth.clientId ?? 'unknown',
        scope: ctx.auth.scope,
      };
      const limited = await env.USER_RATE_LIMITER.limit({ key: identity.uid });
      if (!limited.success) {
        return Response.json(
          { error: 'rate_limited' },
          { status: 429, headers: { 'Retry-After': '60' } },
        );
      }
      const denied = await scopeCheck(request, env, deps, ctx.auth, identity);
      if (denied) return denied;

      if (!handler || handlerEnv !== env) {
        handlerEnv = env;
        handler = createMcpHandler(() => buildServer(env, deps));
      }
      return handler.fetch(request, {
        authInfo: {
          // The bearer token stays here: handlers and services never see it.
          token: '[validated]',
          clientId: identity.clientId,
          scopes: identity.scope,
          ...(ctx.auth.expiresAt ? { expiresAt: ctx.auth.expiresAt } : {}),
          extra: { uid: identity.uid },
        },
      });
    },
  };
}
