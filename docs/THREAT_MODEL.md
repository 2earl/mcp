# 2earl MCP gateway: threat model

Status: M1, with [DESIGN.md](DESIGN.md). Threats owned by the authorization server (sign-in,
consent, token issuance, second factor) are in
[login's threat model](https://github.com/2earl/login/blob/main/docs/THREAT_MODEL.md).

## Assets

1. **Users' data in the services behind the gateway** (prompt-share first), reachable through
   tool calls.
2. **Tool traffic:** arguments and results. In memory on every call, never stored.
3. **Integrity of tool definitions** shown to assistants.
4. **The security log** (`audit_events`).
5. Availability of the endpoint.

## Trust boundaries

- MCP client → gateway: an untrusted client holding a login-issued token.
- Gateway → login: Service Binding RPC, same Cloudflare account.
- Gateway → first-party services: Service Binding to a named entrypoint, same account. The
  service trusts the gateway's identity headers; nothing outside the account can reach the
  entrypoint.
- Tool definitions and results: content from a service. Trusted as code for first-party services,
  untrusted for third-party ones. Untrusted as model input for both, because results may carry
  text users or others wrote.

## Threats and controls

| Threat | Control | Verified by |
|---|---|---|
| Token passthrough / audience confusion | Only tokens for `https://mcp.2earl.com/mcp` from login; validated over the binding; replaced by `[validated]` before MCP handling; services get headers, never the token | `gateway.test.ts`: services never see `Authorization` or the token |
| Forged identity headers | Only the gateway's binding reaches `GatewayMcp`; services must ignore `X-2earl-*` on public routes (UPSTREAM_CONTRACT §2) | Each service's tests |
| A service learns permissions meant for another | Each service is told only its own scopes | Test: another service's scope isn't passed on |
| Calling a tool without its permission | Scope from the pinned definition; `403 insufficient_scope` before the service is called; checked again in the handler; unannotated tools need `write` | Tests: step-up, write implies read, tool-named scope |
| Tool poisoning, rug pull | Hash over everything the model sees and the scope; third-party changes hidden until approved; first-party changes audited | Tests: hidden, approved, hidden again; first-party audited |
| Cross-user access | The user comes from the validated token only; services key data by `X-2earl-User`, never by argument | Gateway tests; each service's tests |
| SSRF | Services are a code list reached over bindings; no URL from users or metadata is fetched; `global_fetch_strictly_public`; same-origin redirects only | Review; config |
| Prompt injection in tool results | Not preventable by filtering. No chaining by the gateway; results labelled by service through tool titles | Documented residual risk |
| Data left behind after account deletion | Gateway and each service answer login's outbox themselves; idempotent; login retries every 15 minutes | Test: delete and retry |
| Who-did-what kept forever | Audit entries re-keyed on deletion; deleted after 90 days | Test; daily cron |
| Sensitive data in logs | Audit stores tool names and outcomes, never arguments or results; Worker observability off | Test: written text absent from the log |
| Abuse and cost | Per-user rate limit (120/min); 25 s per service call; tool lists capped at 500 | Config; tests for a failing service |
| A failing service hides everything | Services listed in parallel, failures dropped; `whoami` always answers | Test |
| Supply chain (MCP SDK, OAuth library) | Exact versions, 24 h release delay, Dependabot, CodeQL, lockfile, `pnpm audit` in CI | CI |

## Residual risks

- **Prompt injection** through content users wrote (a shared prompt, for example) stays possible.
  It is a property of letting a model read that content.
- **A compromised Worker in the 2earl Cloudflare account**, or a compromised account, could bind to
  a service's `GatewayMcp` and act as any user. Mitigation: account access is limited to the owner and
  one trusted administrator (accepted risk R1 in login); deploys need the owner's approval.
- **A compromised first-party deploy** changes tools at once (no hiding). It could already read
  and change that service's data, so hiding would not contain it; the change is audited.

## Later (third-party servers, DESIGN.md §9)

Adds: stored upstream tokens (encryption, binding to user and server), the confused deputy on
connect, login CSRF on connect, SSRF through OAuth discovery, refresh loops. Controls are
sketched in DESIGN.md §9 and get their own rows here when that phase starts.
