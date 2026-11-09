# 2earl MCP gateway: design

Status: **M1 built** (gateway, CI, deploy, Terraform). Not deployed until the first-deployment
steps in [infra/README.md](../infra/README.md) are done.

Related:
- [2earl/login](https://github.com/2earl/login), the authorization server;
- login's [GATEWAY_INTEGRATION.md](https://github.com/2earl/login/blob/main/docs/GATEWAY_INTEGRATION.md),
  the contract this design builds on;
- [UPSTREAM_CONTRACT.md](UPSTREAM_CONTRACT.md), what a 2earl service implements to appear
  behind the gateway.

Specification: MCP revision **2026-07-28**.

## 1. What the gateway does

There is one MCP endpoint, `https://mcp.2earl.com/mcp`. An AI assistant (Claude, Cursor, any MCP
client) connects to it with a 2earl account, and behind it are the MCP servers of **2earl's own
services**. The first of these is **prompt-share**, which exposes its own MCP server. The
assistant sees one server and one sign-in.

The gateway itself has one tool, `whoami`: which account, which app, which permissions. Every
other tool belongs to a service.

Third-party MCP servers (GitHub, Notion, …), each reached with the user's own account there, are
a later phase (§9). Nothing in M1 depends on them.

## 2. Decisions

| # | Decision | By |
|---|---|---|
| G1 | Own repository `2earl/mcp`, public, AGPL-3.0, same protections as login | Owner, 2026-11-09 |
| G2 | Both proxied services and own tools | Owner, 2026-11-09 |
| G3 | Resource `https://mcp.2earl.com/mcp`; tokens from login only, validated over a Service Binding | Owner, 2026-11-09 |
| G4 | Deleting a 2earl account deletes the user's data in the gateway **and in every service behind it** | Owner, 2026-11-09 |
| G5 | Each service has its own permission set | Owner, 2026-11-09 |
| G6 | First service: prompt-share, 2earl's own, exposing its own MCP server | Owner, 2026-11-09 |
| G7 | Changed tools are hidden until the owner approves them: **for third-party services**. First-party changes are offered at once and audited (§5.2) | Owner (hiding), 2026-11-09; first-party exception proposed |
| G8 | The gateway's data is part of login's "Download your data" | Owner, 2026-11-09 |
| G9 | Per-service scopes `mcp:<service>.<permission>`; `mcp:tools.invoke` dropped (§4) | Delegated to Claude by the owner, 2026-11-09 |
| G10 | First-party services are reached over a Service Binding, not a public URL or OAuth (§3) | Proposed with M1 |
| G11 | Stateless MCP: no protocol sessions, no Durable Objects | M1 |
| G12 | Services are a code-reviewed list in this repo (`src/upstreams.ts`), never a URL a user types | M1 |
| G13 | HCP Terraform workspace `2earl-mcp`, working directory `infra` | Owner, 2026-11-09 |

## 3. Architecture

```
                        login.2earl.com (authorization server)
                              ▲ OAuth (MCP clients: consent, tokens)
                              │
MCP client ─ Bearer ─▶ mcp.2earl.com/mcp ── RPC validateToken ──▶ login
                        │  Worker "mcp"   ◀── RPC AccountEvents.deleteUser/exportUser ── login
                        │
                        ├─ whoami
                        └─ Service Binding ──▶ prompt-share, entrypoint GatewayMcp (MCP over fetch)
                              X-2earl-User / -Client / -Scopes          ▲
                                                                        │ RPC AccountEvents
                                                                   login ┘ (its own deletion)
```

- **Runtime:** one Worker `mcp`, custom domain `mcp.2earl.com`, same Cloudflare account as
  login. `workers.dev` and preview URLs are off.
- **Protocol:** `@modelcontextprotocol/server` 2.x `createMcpHandler`. Each request gets a fresh
  server: no `Mcp-Session-Id`, no standalone streams. Clients on the stateless 2025 Streamable
  HTTP are served from the same definition.
- **Auth:** `OAuthResourceServer` from `@cloudflare/workers-oauth-provider`. It publishes RFC 9728
  metadata, answers the `401`/`403` challenges, and validates through
  `env.AUTH_SERVER.validateToken`. The bearer token goes no further than this step.
- **Services:** an MCP client (`@modelcontextprotocol/client`) per request and service. It speaks
  Streamable HTTP over the service's Service Binding (a named `GatewayMcp` entrypoint), so there
  is no public URL and no network hop. The user's identity travels in headers (§3.1).
- **Storage:** D1 `mcp`, EU jurisdiction: tool pins and the security log (§6).

### 3.1 Why identity headers, not OAuth, between the gateway and a first-party service

A named entrypoint can be reached only by a Worker in the same Cloudflare account that binds to
it; it has no public route. The gateway is the only Worker that binds to `GatewayMcp`, so
headers it sets are as trustworthy as an RPC argument.
OAuth between the two would add:
- a second token per user and service;
- a second consent;
- a token store;

and protect against nothing an attacker inside the account couldn't do anyway.

The service is told:
- `X-2earl-User`: the user's stable 2earl ID;
- `X-2earl-Client`: the assistant's client ID;
- `X-2earl-Scopes`: of the token's scopes, **only that service's own**, with `write` implying
  `read` already applied.

It is never sent the token. Services must not accept these headers on their public routes
(UPSTREAM_CONTRACT §2).

## 4. Permissions

The owner set the rule: each service has its own permission set, and more apps will follow. The
gateway therefore:
- gives each service its own namespace, `mcp:<service>.<permission>`;
- requires every service to have at least `read` and `write`;
- lets a service add more where one approval would be too broad. For example, prompt-share could
  have `mcp:promptshare.publish` for making a prompt public, separate from editing your own. (It
  doesn't: publishing is a website-only action there. Its set is `mcp:promptshare.read`, `.write`,
  `.state`.)

| Scope | Allows | Declared |
|---|---|---|
| `mcp:tools.read` | See which tools exist; `whoami`. Implied by any service scope | login registry (exists) |
| `mcp:<service>.read` | That service's read-only tools | login registry, when the service is added |
| `mcp:<service>.write` | That service's other tools. Implies `read` | idem |
| `mcp:<service>.<other>` | Tools that name it in `_meta["2earl/scope"]` | idem |

Which scope a tool needs (`src/scopes.ts`):
1. The scope the tool names in `_meta["2earl/scope"]`, if it is one of the service's own.
2. Otherwise `read` for a tool annotated `readOnlyHint: true`.
3. Otherwise `write`.

An unannotated tool therefore needs `write`, so a service forgetting an annotation fails closed.

A missing scope on `tools/call` is answered with `403 insufficient_scope` and the scope needed,
before the service is called (MCP step-up). The client can then ask the user for exactly that
permission on login's consent page.

`mcp:tools.invoke` is **dropped**. It was a placeholder for "call 2earl's own tools". The only own
tool, `whoami`, is read-only, so `invoke` would be a consent line that grants nothing. Removing it
from login's registry is part of the login change in §8.

Why not one permission for everything behind the gateway: one approval would then cover every
service, present and future. With per-service scopes the consent page says *what* the assistant
gets ("Read your prompts in Prompt share"), and a user can grant one service without another.

## 5. Services behind the gateway

### 5.1 The list (`src/upstreams.ts`)

Each service is declared in code:
- `id`: the tool prefix (`<id>__<tool>`) and the scope namespace;
- display name;
- Service Binding name;
- `trust`: `first-party` or `third-party`;
- its scopes.

Adding a service is a pull request here, plus a binding in `wrangler.jsonc`, plus its scopes in
login's registry. The list has Prompt share (2earl/promptshare).

`tools/list` asks every service in parallel and shows each one's tools prefixed and titled with
the service's name ("Prompt share: Search prompts"). A service that fails or times out (25 s) is
left out of that response; the others and `whoami` still answer.

### 5.2 Tool pinning

What an assistant reads in a tool definition, the description above all, steers its model. A
changed definition can carry instructions ("tool poisoning") or change a tool after users agreed
to it ("rug pull"). So:
- the gateway hashes each tool's visible definition when first seen: name, title, description,
  input and output schema, annotations, the scope it needs;
- a new or changed **third-party** tool is recorded `pending` and hidden until the owner approves
  it. In M1 that is an `UPDATE tool_pins SET status = 'approved' …` on D1; an admin page is M3;
- a new or changed **first-party** tool is recorded, audited (`tool.added`, `tool.changed`) and
  offered at once.

The first-party exception departs from the owner's "hide until approved". The reason: a
first-party service's tools are reviewed in its own pull request and deployed with the owner's
approval. That review is the approval, and pinning protects against changes nobody reviewed.
Hiding them again would make every prompt-share release remove its changed tools for all users,
until the owner approves them a second time with no page yet to do it on. Someone able to deploy
a malicious prompt-share already has prompt-share's data, so the pin adds no protection there.
The audit entry keeps the change visible.

### 5.3 Results

Tool results pass through unchanged and are never stored or logged. The gateway doesn't chain
calls: the assistant and the user decide what runs next.

## 6. Data (D1 `mcp`, EU)

| Table | Holds | Kept |
|---|---|---|
| `tool_pins` | per service and tool: definition hash, `approved`/`pending`, times | While the service is listed |
| `audit_events` | `tool.called`/`denied`/`failed` with service, tool **name** and outcome; user ID and client ID; `tool.added`/`changed`/`held`; `user.deleted` | 90 days (daily cron) |

**No tool arguments or results are stored or logged.** Per-user state lives in the services, not
in the gateway.

### 6.1 Account deletion (G4)

login keeps a deletion outbox and calls every registered service's `AccountEvents.deleteUser`
until each succeeds (every 15 minutes).
- **The gateway** (`AccountEvents` in `src/index.ts`) re-keys the user's audit entries to
  `deleted:<random>`, so the security log keeps what happened but no longer says who, and records
  `user.deleted`. It is idempotent.
- **Each service** has its own `AccountEvents` and its own entry in login's registry
  (UPSTREAM_CONTRACT §4). The gateway doesn't relay deletion: a service may hold data from its
  own web app too, and login must know whether *that service* has finished.

### 6.2 Export (G8)

`AccountEvents.exportUser(uid)` returns the gateway's security-log entries about the user. login's
"Download your data" calls it over the same binding (§8). Each service exports its own data the
same way.

## 7. Security summary

Full table in [THREAT_MODEL.md](THREAT_MODEL.md). The main controls:
- **No token passthrough:** the 2earl token is validated and dropped; services get identity
  headers.
- **Audience:** only tokens for `https://mcp.2earl.com/mcp`, issued by login, accepted.
- **Least privilege per service:** a service is told only its own scopes; scopes are re-checked
  against the pinned definition before each call.
- **No SSRF surface:** services are a code list reached over bindings; the Worker runs with
  `global_fetch_strictly_public`; service transports refuse cross-origin redirects.
- **Tool poisoning:** pinning, hiding for third-party, audit for first-party.
- **Abuse:** a per-user rate limit (120 requests a minute, namespace `1002`) and a 25 s timeout
  per service call. Zone constraint from login: the gateway serves no `/authorize`,
  `/oauth/token`, `/callback/google` or `/login`.

## 8. Changes outside this repository

**login** (one PR after the gateway is deployed; the binding fails if the Worker doesn't exist):
1. Drop `mcp:tools.invoke` from the registry entry `mcp`.
2. Binding `MCP_GATEWAY_EVENTS` → `{ "service": "mcp", "entrypoint": "AccountEvents" }`.
3. "Download your data" calls `exportUser` on every registered service that has a binding.

**prompt-share** (M2): implements UPSTREAM_CONTRACT. Then a login PR adds its scopes
(`mcp:promptshare.*`) to the `mcp` entry and registers prompt-share itself with its deletion binding.

**2earl.com:** the privacy policy covers the gateway and each service before launch.

## 9. Later: third-party MCP servers

Not built. This is what it needs, and why it waits for a concrete server:
- **Per-user accounts:** a user connects their own account at each server once, on a gateway page
  signed in with login. The upstream OAuth transaction (`state`, PKCE, `resource`, `iss` check)
  is created only after the user presses Connect: MCP's confused-deputy rule.
- **Client identity at the server**, in MCP's order of preference: pre-registered; Client ID
  Metadata Document at `https://mcp.2earl.com/oauth/client.json`; Dynamic Client Registration
  (deprecated) once per server.
- **Storage:** encrypted upstream tokens per user (AES-256-GCM, key as a Worker secret, bound to
  user and server); deleted with the account and revoked at the server where possible.
- **SSRF:** discovered OAuth URLs must be `https`; fetches strictly public; no redirects on token
  requests.

The gateway's `trust: 'third-party'` hiding and its scope model already apply to such servers.

## 10. Infrastructure and CI

- **Terraform** in `infra/` (HCP workspace `2earl-mcp`, working directory `infra`, manual apply):
  - D1 `mcp` in the EU, protected from destroy;
  - custom domain `mcp.2earl.com`;
  - the zone, read only. Zone-wide settings stay in login's Terraform.
- **CI:** the required check `verify` runs typecheck (including generated Worker types), lint and
  format, the Workers-runtime tests, the bundle, and `pnpm audit`.
- **Deploys:** only from `main`, through the `production` environment with the owner's approval.
  They apply D1 migrations and then deploy, and smoke-test `/healthz`.
- **Supply chain:** SHA-pinned actions, exact dependency versions, pnpm's 24 h release delay,
  Dependabot, CodeQL.
- **Secrets** (production environment): `CLOUDFLARE_API_TOKEN` only. The gateway itself holds no
  secret in M1.

## 11. Phases

| Phase | Deliverable | State |
|---|---|---|
| M0 | Design and threat model | Done (PR #1) |
| M1 | Worker: auth via login, `whoami`, service plumbing (bindings, scopes, step-up, pinning, audit), `AccountEvents` delete and export; CI, deploy, Terraform. Then login's binding and export hook | Done; deployed |
| M2 | prompt-share's `GatewayMcp` (its repository); its entry here; its scopes and deletion in login. The resource metadata advertises every service's scopes, so assistants can ask for them at first sign-in | Built; waits for promptshare's deploy |
| M3 | Owner page for held tools; a real assistant end to end (browser test through consent); privacy policy; launch | |
| Later | Third-party MCP servers (§9) | When one is wanted |
