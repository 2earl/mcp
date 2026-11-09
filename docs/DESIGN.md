# 2earl MCP gateway: design

Status: **proposal for review.** No gateway code exists yet. Decisions marked **open** need the
owner before the phase that depends on them.

Related: [2earl/login](https://github.com/2earl/login), the authorization server, and its
[GATEWAY_INTEGRATION.md](https://github.com/2earl/login/blob/main/docs/GATEWAY_INTEGRATION.md),
the contract this design builds on. Specification: MCP revision **2026-07-28**.

## 1. What the gateway does

One MCP endpoint, `https://mcp.2earl.com/mcp`, that an AI assistant (Claude, Cursor, any MCP
client) connects to with a 2earl account. Behind it:

- **2earl's own tools**, implemented in the gateway.
- **Connected MCP servers ("upstreams")**: remote MCP servers the owner allows (for example
  GitHub or Notion). A user connects their own account at each upstream once, on
  `mcp.2earl.com`; the gateway then offers that upstream's tools under a prefix and calls them
  with the user's own upstream credentials.

The assistant sees one server and one sign-in. The user decides:
- which assistants may use the gateway (at login.2earl.com);
- which upstream accounts are connected (at mcp.2earl.com).

## 2. Decisions

| # | Decision | By |
|---|---|---|
| G1 | Own repository `2earl/mcp`, public, AGPL-3.0, same protections as login | Owner, 2026-11-09 |
| G2 | Built in this session; both own tools and proxied upstreams | Owner, 2026-11-09 |
| G3 | Resource `https://mcp.2earl.com/mcp`; tokens from login only, validated over a Service Binding | Owner, 2026-11-09 (login) |
| G4 | Deleting a 2earl account deletes the user's gateway data (`AccountEvents.deleteUser`) | Owner, 2026-11-09 (login) |
| G5 | Each service has its own permissions; the gateway's are declared in login's registry | Owner, 2026-11-09 (login) |
| G6 | Stateless MCP (2026-07-28): no protocol sessions, no Durable Objects for the protocol | Proposed |
| G7 | Upstreams are a code-reviewed allowlist in this repo, never a URL a user types | Proposed |
| G8 | Upstream credentials are stored encrypted, per user, in D1 (EU), and never leave the gateway | Proposed |

## 3. Architecture

```
                          login.2earl.com (authorization server)
                                ▲ OAuth (MCP clients)    ▲ OAuth (gateway web sign-in)
                                │                        │
MCP client ── Bearer ──▶ mcp.2earl.com/mcp ──RPC──▶ login: validateToken, (later) export
                          │  Worker "mcp"                ▲
                          │                              │ RPC: AccountEvents.deleteUser
                          ├── own tools                  │
                          ├── upstream MCP client ──▶ github MCP, notion MCP, … (allowlist)
                          │      with the user's upstream token (D1, encrypted)
                          └── web: /connections (sign in with 2earl, connect/disconnect)
```

- **Runtime:** one Cloudflare Worker `mcp`, custom domain `mcp.2earl.com`, same account as login.
- **Protocol:** `@modelcontextprotocol/server` (v2 SDK) `createMcpHandler`: a fresh server per
  request, no `Mcp-Session-Id`, no standalone streams. The 2026-07-28 revision is stateless.
  Clients on the stateless 2025 Streamable HTTP still work on the same route.
- **Auth:** `OAuthResourceServer` from `@cloudflare/workers-oauth-provider`. It validates through
  `env.AUTH_SERVER.validateToken`, wrapping the MCP handler (GATEWAY_INTEGRATION §3).
- **Web pages** (`/connections`, OAuth callbacks): Hono, server-rendered, the same visual
  identity as login, CSP without scripts.
- **Storage:** D1 `mcp` and KV `MCP_CACHE`, both in the EU jurisdiction.

## 4. MCP requests

1. `OAuthResourceServer` validates the bearer token, giving `uid`, `clientId` and `scope`.
2. `tools/list` returns:
   - own tools the token's scopes allow;
   - for each upstream the user has connected **and** the token's scopes allow, that upstream's
     tools (filtered by the allowlist, §6.3), prefixed `<upstream>__<tool>`.
3. `tools/call` routes on the prefix:
   - an own tool runs in the Worker;
   - an upstream tool calls the upstream through the MCP client, with the user's upstream
     access token. On `401` the token is refreshed once. If that fails, the connection is marked
     "reconnect" and the tool returns an error naming `https://mcp.2earl.com/connections`.
4. Scope errors answer `insufficientScope(...)` with every scope the call needs (MCP step-up).

Upstream tool lists are cached per user and upstream in KV, honouring the upstream's `ttlMs`
(default 5 minutes). Calls and lists have timeouts and response-size limits.

## 5. Connecting an upstream account

### 5.1 Signing in to mcp.2earl.com

The web pages need to know which 2earl user is in the browser. The gateway signs in **with
login, as an OAuth client** (authorization code + PKCE):
- client: registered once in login `/admin` → Apps;
- redirect URI: `https://mcp.2earl.com/auth/callback`;
- resource: the gateway's own;
- scope: `mcp:connections`.

It validates the token over the binding to get `uid`, discards the token, and sets its own
`__Host-session` cookie (host-only, 12 h). The user already has a login session, so this is
a redirect and, once remembered, no click.

### 5.2 The upstream flow

On `/connections`, the signed-in user presses **Connect** for an allowed upstream. Then:
1. The gateway discovers the upstream's authorization server:
   - the upstream's RFC 9728 metadata, then its RFC 8414 or OIDC metadata;
   - every discovered URL must be `https`;
   - fetches run under `global_fetch_strictly_public`.
2. It creates an OAuth transaction (`state`, PKCE `S256`, `resource` = the upstream's canonical
   URI). It is bound to the gateway session, single-use and 10 minutes long, and is created
   **only after** the user pressed Connect: MCP's per-client-consent rule.
3. The browser goes to the upstream's authorization page.
4. On the callback:
   - `state` must match;
   - `iss` is checked (RFC 9207);
   - the code is exchanged;
   - tokens are stored encrypted (§8).

**Client identity at each upstream**, in MCP's order of preference:
1. **Pre-registered:** the owner registers the gateway with the upstream provider; the client ID
   and secret are Worker secrets.
2. **Client ID Metadata Document:** the gateway publishes
   `https://mcp.2earl.com/oauth/client.json` (public client, PKCE, redirect
   `https://mcp.2earl.com/connections/callback`).
3. **Dynamic Client Registration** (deprecated in MCP, still common): one registration per
   upstream, stored in D1, never per user.

### 5.3 Why this avoids the confused deputy

MCP's security guide describes a proxy that forwards an MCP client's authorization straight to a
third party under one static client ID; consent cookies then let an attacker's client skip
consent. Here, connecting an upstream is never part of an MCP client's authorization. It happens
only on the gateway's own page, by the signed-in user pressing Connect, with CSRF protection.
Which MCP clients may then use the connected account is decided on login's consent page,
per client and per scope (§7).

## 6. Upstreams

### 6.1 The allowlist (`src/upstreams.ts`)

Each upstream is declared in code:
- `id` (the tool prefix and scope suffix);
- display name;
- canonical MCP URL;
- client-registration method;
- tool allowlist (§6.3).

Adding one is a pull request. Users can't add arbitrary URLs: the gateway never fetches a URL a
user typed (SSRF, G7).

### 6.2 Which upstreams first: **open (owner)**

The gateway works with any remote MCP server that supports OAuth 2.1 with PKCE. Which ones to
offer first decides which providers the owner registers the gateway with (§5.2).

### 6.3 Tool allowlist and description pinning

Upstream tool descriptions reach the assistant's model. A compromised or changed upstream can
put instructions in them ("tool poisoning") or change a tool's behaviour after it was approved.
Proposed:
- each upstream lists the tools the gateway offers;
- the gateway records a hash of each tool's name, description and input schema when first
  seen;
- a tool whose hash changes is **hidden** until the owner re-approves it in the gateway's
  admin view, and the change is audited.

## 7. Permissions

Declared in login's service registry (`src/services.ts`, entry `mcp`), each with consent
wording:

| Scope | Allows |
|---|---|
| `mcp:tools.read` | list tools (exists) |
| `mcp:tools.invoke` | call 2earl's own tools (exists) |
| `mcp:connections` | the gateway's own web sign-in: manage connected accounts. Only the gateway's first-party client |
| `mcp:<upstream>` | list and call that upstream's tools with the user's connected account. One per upstream, e.g. `mcp:github`. **Open (owner):** recommended |

Per-upstream scopes make login's consent page say *which* connected accounts an assistant may
use ("Use your GitHub account through 2earl"), and let a user give an assistant GitHub without
Notion. The alternative is one `mcp:tools.invoke` for everything: fewer prompts, but one
approval covers every connected account. Scope hierarchy (MCP requires one):
`mcp:tools.invoke` ⊇ `mcp:tools.read`, and `mcp:<upstream>` ⊇ listing that upstream's tools.

## 8. Data (D1 `mcp`, EU)

| Table | Holds | Kept |
|---|---|---|
| `web_sessions` | hash of the gateway session cookie, `uid`, times | 12 h idle / 7 days |
| `connections` | `uid`, upstream, status; upstream access and refresh tokens (AES-256-GCM, key from `UPSTREAM_TOKEN_KEY`, bound to `uid` + upstream); expiry; granted scope | Until the user disconnects or deletes the 2earl account |
| `oauth_tx` | hashed `state`, PKCE verifier, `uid`, upstream | ≤ 10 minutes, single use |
| `upstream_clients` | DCR registrations, one per upstream (secrets encrypted) | While the upstream is allowed |
| `tool_pins` | hash per upstream tool, approval state | While the upstream is allowed |
| `audit_events` | connection added/removed/refreshed/failed, tool **name**, upstream and outcome. Never arguments or results | 90 days |

KV `MCP_CACHE`: upstream tool lists per `uid` + upstream, minutes.

**No tool arguments or results are stored or logged.** They pass through memory only.

### 8.1 Account deletion (G4)

`AccountEvents.deleteUser(uid)`:
- revokes each upstream token at the upstream (RFC 7009 where supported, best effort);
- deletes `connections`, `web_sessions`, `oauth_tx` and the KV cache entries for `uid`;
- keeps audit entries, re-keyed as login does.

It is idempotent and throws if anything remains (login retries every 15 minutes). After
deployment a login PR adds the binding.

### 8.2 Access and export: **open (owner)**

GDPR Art. 15 covers the gateway's data too. Proposed: `AccountEvents.exportUser(uid)` returns
the user's connections (no tokens) and audit entries. login's "Download your data" includes it,
so the user keeps one place for both rights.

## 9. Security summary

Full table in [THREAT_MODEL.md](THREAT_MODEL.md). The main controls:
- **Token passthrough is impossible by construction.** The 2earl token is validated and dropped;
  upstreams only ever see their own tokens.
- **Audience:** only tokens for `https://mcp.2earl.com/mcp`, from login.
- **Confused deputy:** upstream connections only from the gateway's own signed-in page, with
  `state` created after the click (§5.3).
- **SSRF:**
  - upstreams come from the code allowlist;
  - discovered OAuth URLs must be `https`;
  - fetches are strictly public;
  - no redirects followed on token requests.
- **Upstream credentials:** encrypted at rest, bound to user and upstream, never logged or
  returned to a client.
- **Tool poisoning and rug pulls:** allowlist plus description pinning (§6.3).
- **Prompt injection through tool results:** can't be filtered reliably. The gateway labels
  results by source, limits their size, and never chains calls itself; the assistant and the
  user stay in control of what is called next.
- **Abuse:** per-user and per-network rate limits (Workers Rate Limiting, namespace `1002`).
  Zone constraint from login: don't serve `/authorize`, `/oauth/token`, `/callback/google` or
  `/login`.

## 10. Infrastructure and CI

- **Terraform** in `infra/` (HCP workspace `2earl-mcp-prod`, working directory `infra`):
  - custom domain `mcp.2earl.com`;
  - D1 and KV in the EU;
  - zone referenced by data source.

  Zone-wide settings stay in login's Terraform.
- **CI and deploys:** as in login:
  - required `verify` check (typecheck, lint, Workers tests, browser tests, bundle);
  - deploys only from `main`, through the `production` environment with owner approval;
  - SHA-pinned actions;
  - pnpm release-age delay, Dependabot, CodeQL.
- **Secrets** (production environment):
  - `CLOUDFLARE_API_TOKEN`;
  - `UPSTREAM_TOKEN_KEY`, `SESSION_PEPPER`;
  - per pre-registered upstream: its client secret.

## 11. Changes in login

1. Registry entry `mcp`: add `mcp:connections`, and per-upstream scopes if chosen (§7).
2. Register the gateway's web sign-in client in `/admin` (redirect
   `https://mcp.2earl.com/auth/callback`).
3. After the gateway is deployed: the `MCP_GATEWAY_EVENTS` binding (`service: "mcp"`,
   `entrypoint: "AccountEvents"`).
4. If §8.2 is accepted: export includes the gateway's part.
5. Privacy policy on 2earl.com: the gateway's data, before launch.

## 12. Phases

| Phase | Deliverable |
|---|---|
| M0 | This design and threat model (PR) |
| M1 | Worker, CI, deploy, Terraform. MCP endpoint behind login with 2earl's own tools. `AccountEvents`. login binding. **An assistant can connect and use own tools** |
| M2 | Web sign-in with login; `/connections`; upstream OAuth (pre-registered, CIMD, DCR); encrypted token store; deletion of connections |
| M3 | Proxied `tools/list` and `tools/call`; refresh; allowlist and pinning; rate limits; audit |
| M4 | Browser tests (consent, connect, call), a real assistant end to end, export hook, privacy policy, launch |

## 13. Open decisions for the owner

1. **First upstreams (§6.2):** which MCP servers to offer first.
2. **First own tools (§1):** what 2earl's own tools should do. Without an answer, M1 ships two:
   - `whoami`: your 2earl account ID and what this assistant may do;
   - `connections`: your connected accounts, and a link to connect more.
3. **Per-upstream scopes (§7):** recommended.
4. **Tool allowlist and description pinning (§6.3):** recommended.
5. **Gateway data in the account export (§8.2):** recommended.
