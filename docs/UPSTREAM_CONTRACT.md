# Putting a 2earl service behind the gateway

What a first-party service (prompt-share first) implements so that its MCP tools appear at
`https://mcp.2earl.com/mcp`. Why it works this way: [DESIGN.md §3.1](DESIGN.md#31-why-identity-headers-not-oauth-between-the-gateway-and-a-first-party-service).

## 1. Serve MCP from a named entrypoint

The service's Worker exports a `WorkerEntrypoint` named **`GatewayMcp`**. Its `fetch` serves
stateless MCP Streamable HTTP at `/mcp`. The gateway calls it as `https://<id>.internal/mcp`; the
host name means nothing, because the request never leaves Cloudflare.

```ts
import { WorkerEntrypoint } from 'cloudflare:workers';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';

interface Caller {
  user: string;
  scopes: string[];
}

function buildServer(env: Env, caller: Caller): McpServer {
  const server = new McpServer({ name: 'prompt-share', version: '1.0.0' });
  server.registerTool(
    'search_prompts',
    {
      title: 'Search prompts',
      description: 'Finds your prompts and the ones shared with you.',
      inputSchema: z.object({ query: z.string().max(200) }),
      annotations: { readOnlyHint: true },
    },
    async ({ query }) => {
      // Always scoped to caller.user, never to an ID from the arguments.
      return { content: [{ type: 'text', text: '…' }] };
    },
  );
  return server;
}

export class GatewayMcp extends WorkerEntrypoint<Env> {
  override async fetch(request: Request): Promise<Response> {
    const user = request.headers.get('X-2earl-User');
    if (!user) return new Response('missing caller', { status: 400 });
    const scopes = (request.headers.get('X-2earl-Scopes') ?? '').split(' ').filter(Boolean);
    return createMcpHandler(() => buildServer(this.env, { user, scopes })).fetch(request);
  }
}
```

The gateway's `wrangler.jsonc` binds to it:

```jsonc
{ "binding": "PROMPT_SHARE", "service": "prompt-share", "entrypoint": "GatewayMcp" }
```

## 2. Trust the identity headers only there

| Header | Value |
|---|---|
| `X-2earl-User` | The user's stable 2earl ID (`uid` from login), from a token login validated |
| `X-2earl-Client` | The assistant's OAuth client ID (a URL for CIMD clients) |
| `X-2earl-Scopes` | Space-separated. Only this service's scopes from the token; `write` already implies `read` |

Rules:
- **Only `GatewayMcp` may read these headers.** The service's public `fetch` (its website, its
  API) must ignore them. Anyone on the Internet can send them there.
- Look data up by `X-2earl-User`. Never take a user ID, owner ID or account ID from tool
  arguments.
- Check `X-2earl-Scopes` again before anything that writes. The gateway checks first and
  answers `403` itself, but the service shouldn't depend on one check only.
- There is no token. Don't ask for one, don't call login with these values.

## 3. Declare tools so the gateway can protect them

- **`readOnlyHint: true`** on every tool that changes nothing: it then needs `read`. Any tool
  without it needs `write`. A missing annotation fails closed.
- A tool that needs a narrower permission names it: `_meta: { "2earl/scope": "mcp:prompts.publish" }`.
  The scope must be one of the service's own, listed in the gateway and in login (§5), or it is
  ignored.
- Tool names: letters, digits, `_` and `-`, without `__` (the gateway's prefix separator). The
  gateway shows them as `<id>__<name>`.
- Write descriptions as reviewed content. They reach every user's assistant, and a change is
  recorded in the gateway's audit log (`tool.changed`).
- No sessions, no server-to-client requests (sampling, elicitation): the gateway is stateless and
  doesn't relay them.
- Errors are tool results with `isError: true` and a sentence the user can act on. A thrown
  exception reaches the user as "Prompt share couldn't complete this request".
- Answer within 25 seconds and keep results small; the assistant pays for every token.

## 4. Delete and export the user's data

The service holds its own data, so it answers login itself, like the gateway does:
- export a second named entrypoint **`AccountEvents`** with
  - `deleteUser(userId: string): Promise<void>`: deletes everything about the user. Idempotent;
    throws if anything remains, so login retries;
  - `exportUser(userId: string): Promise<unknown>`: what "Download your data" includes;
- register the service in login's registry (`src/services.ts`) with its `deletionBinding`, and
  add that binding to login's `wrangler.jsonc`. login's outbox then calls it every 15 minutes
  until it succeeds.

## 5. Declare scopes in both places

| Where | What |
|---|---|
| login `src/services.ts`, entry `mcp` | Each scope with its consent wording, e.g. `'mcp:prompts.read': 'Read your prompts in Prompt share'` |
| gateway `src/upstreams.ts` | `scopes: { read: 'mcp:prompts.read', write: 'mcp:prompts.write', publish: 'mcp:prompts.publish' }` |

The `mcp:` prefix means "through the gateway" (the token's audience is the gateway). The service's
own website, if it has one, signs in with login as its own service with its own scopes.

## 6. Checklist for adding a service

1. The service: `GatewayMcp` and `AccountEvents` entrypoints, deployed.
2. login PR: scopes under `mcp`, the service's own registry entry with `deletionBinding`, its
   binding.
3. gateway PR: the entry in `UPSTREAMS` (`trust: 'first-party'`), the Service Binding in
   `wrangler.jsonc`, a test against a stand-in of the service.
4. Deploy login first (the new scopes must exist before an assistant can ask for them), then the
   gateway.
