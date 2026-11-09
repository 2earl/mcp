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
  /**
   * `all`: every service, tools prefixed `<id>__<tool>`, plus `whoami` (`/mcp`).
   * `single`: one service at its own address, tools as the service names them (`/<id>`).
   */
  mode?: 'all' | 'single';
}

/** A tool's name and title as the assistant sees them. */
function exposed(deps: GatewayDeps, upstream: Upstream, tool: UpstreamTool) {
  if (deps.mode === 'single') return { name: tool.name, title: tool.title ?? tool.name };
  return {
    name: prefixedName(upstream, tool.name),
    title: `${upstream.name}: ${tool.title ?? tool.name}`,
  };
}

/** The service and tool an assistant-facing name refers to. */
function resolve(deps: GatewayDeps, name: string): { upstream: Upstream; tool: string } | null {
  if (deps.mode === 'single') {
    const upstream = deps.upstreams[0];
    return upstream && name ? { upstream, tool: name } : null;
  }
  return splitName(deps.upstreams, name);
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

/** A prompt as a service lists it (MCP `prompts/list`). */
export interface UpstreamPrompt {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  arguments?: { name: string; description?: string; required?: boolean }[] | undefined;
  _meta?: Record<string, unknown> | undefined;
}

/**
 * The scope a prompt needs: one it names itself (`_meta["2earl/scope"]`, if it is one of the
 * service's), else `read`. Prompts only read.
 */
export function promptScope(upstream: Upstream, prompt: UpstreamPrompt): string {
  const named = prompt._meta?.['2earl/scope'];
  if (typeof named === 'string' && Object.values(upstream.scopes).includes(named)) return named;
  return upstream.scopes.read;
}

/**
 * The prompts a service offers this user (docs/DESIGN.md §4.3). Only from first-party services:
 * what a user picks from a prompt menu is sent as their own message, so a third party's text
 * must not get there. Not pinned: a first-party service's prompts are the user's own content
 * (Prompt share lists only the user's own prompts), and they change whenever the user edits one.
 */
async function upstreamPrompts(
  env: Env,
  deps: GatewayDeps,
  upstream: Upstream,
  identity: Identity,
): Promise<{ client: Client; prompts: UpstreamPrompt[] } | null> {
  if (upstream.trust !== 'first-party') return null;
  const client = await connect(env, upstream, identity);
  if (!client.getServerCapabilities()?.prompts) return null;
  const listed: UpstreamPrompt[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listPrompts(cursor ? { cursor } : {});
    listed.push(...(page.prompts as UpstreamPrompt[]));
    cursor = page.nextCursor;
  } while (cursor && listed.length < 200);
  return {
    client,
    prompts: listed.filter((p) => has(identity.scope, promptScope(upstream, p), deps.upstreams)),
  };
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
  const server = new Server(GATEWAY_INFO, { capabilities: { tools: {}, prompts: {} } });

  server.setRequestHandler('tools/list', async (_request, ctx) => {
    const identity = identityOf(ctx.http?.authInfo);
    const tools: unknown[] = deps.mode === 'single' ? [] : [WHOAMI];
    // One failing service doesn't hide the others.
    const lists = await Promise.allSettled(
      deps.upstreams.map(async (upstream) => {
        const { tools: offered } = await upstreamTools(env, deps, upstream, identity);
        return offered.map((tool) => ({ ...tool, ...exposed(deps, upstream, tool) }));
      }),
    );
    for (const list of lists) if (list.status === 'fulfilled') tools.push(...list.value);
    return { tools } as never;
  });

  server.setRequestHandler('tools/call', async (request, ctx) => {
    const identity = identityOf(ctx.http?.authInfo);
    const name = request.params.name;

    if (name === WHOAMI.name && deps.mode !== 'single') {
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

    const target = resolve(deps, name);
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

  server.setRequestHandler('prompts/list', async (_request, ctx) => {
    const identity = identityOf(ctx.http?.authInfo);
    const prompts: unknown[] = [];
    const lists = await Promise.allSettled(
      deps.upstreams.map(async (upstream) => {
        const offered = await upstreamPrompts(env, deps, upstream, identity);
        return (offered?.prompts ?? []).map((prompt) => ({
          ...prompt,
          ...(deps.mode === 'single'
            ? {}
            : {
                name: prefixedName(upstream, prompt.name),
                title: `${upstream.name}: ${prompt.title ?? prompt.name}`,
              }),
        }));
      }),
    );
    for (const list of lists) if (list.status === 'fulfilled') prompts.push(...list.value);
    return { prompts } as never;
  });

  server.setRequestHandler('prompts/get', async (request, ctx) => {
    const identity = identityOf(ctx.http?.authInfo);
    const target = resolve(deps, request.params.name);
    if (!target) throw new Error(`Unknown prompt: ${request.params.name}`);
    const { upstream, tool: name } = target;
    // Names and outcomes only: a prompt's name can carry its title, which is the user's content.
    const log = (event: 'prompt.got' | 'prompt.denied' | 'prompt.failed', outcome?: string) =>
      audit(env.DB, deps.now(), event, {
        actorUserId: identity.uid,
        clientId: identity.clientId,
        detail: { upstream: upstream.id, ...(outcome ? { outcome } : {}) },
      });
    const offered = await upstreamPrompts(env, deps, upstream, identity);
    const definition = offered?.prompts.find((p) => p.name === name);
    if (!offered || !definition) {
      await log('prompt.denied');
      throw new Error(`Unknown prompt: ${request.params.name}`);
    }
    try {
      const result = await offered.client.getPrompt({
        name,
        arguments: request.params.arguments ?? {},
      });
      await log('prompt.got');
      return result;
    } catch (error) {
      await log('prompt.failed', error instanceof Error ? error.name : 'unknown');
      throw new Error(`${upstream.name} couldn’t give this prompt. Try again.`, { cause: error });
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
  const target = resolve(deps, message.params.name);
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
