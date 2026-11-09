# 2earl MCP gateway: threat model

Status: proposal, with [DESIGN.md](DESIGN.md). Threats owned by the authorization server
(sign-in, consent, token issuance, second factor) are in
[login's threat model](https://github.com/2earl/login/blob/main/docs/THREAT_MODEL.md).

## Assets

1. **Upstream credentials:** users' access and refresh tokens for GitHub, Notion and the other
   allowed upstreams. The most valuable asset here: they act as the user outside 2earl.
2. **Tool traffic:** arguments and results. Never stored, but in memory on every call.
3. **Gateway sessions:** the `/connections` cookie.
4. **Integrity of tool definitions** shown to assistants.
5. Availability of the endpoint.

## Trust boundaries

- MCP client → gateway: an untrusted client with a login-issued token.
- Gateway → login: Service Binding RPC, same Cloudflare account.
- Gateway → upstreams: the Internet; upstream servers are partly trusted (owner allowlist), and
  their tool descriptions and results are untrusted content.
- Browser → gateway web pages: an untrusted browser with a 2earl session.

## Threats and controls

| Threat | Control | Verified by (planned) |
|---|---|---|
| Token passthrough / audience confusion | Only tokens for `https://mcp.2earl.com/mcp`, validated by login; the 2earl token is never forwarded; upstreams get their own tokens only | Unit tests; launch checklist |
| Confused deputy through an upstream (MCP security guide) | Upstream connection only from the gateway's own page after the user presses Connect; `state` created after that click, bound to the gateway session, single use, 10 min; no consent cookies of ours that skip anything | Browser test: crafted connect links do nothing |
| Login CSRF on connect (attacker's upstream account attached to the victim) | `state` bound to the session that started the flow; callback refuses another session | Unit test |
| SSRF through discovery or token endpoints | Upstreams only from the code allowlist; discovered URLs must be `https`; `global_fetch_strictly_public`; no redirects on token requests | Unit tests with hostile metadata |
| Theft of stored upstream tokens (database dump, backup) | AES-256-GCM with a key held as a Worker secret, associated data = `uid` + upstream; tokens never in logs, errors or responses | Unit test: rows don't contain plaintext |
| Cross-user access (one user's call uses another's upstream token) | Connection looked up by the `uid` from the validated token only; no client-supplied user IDs or handles | Unit tests |
| Tool poisoning, rug pull (changed tool descriptions or schemas) | Tool allowlist per upstream; hash pinning; changed tools hidden until the owner re-approves; audited | Unit tests |
| Prompt injection in tool results | Not preventable by filtering. The gateway labels results by source, limits size, never chains calls itself; the assistant and user decide | Documented residual risk |
| An assistant uses an account the user didn't mean it to | Per-upstream scopes on login's consent page (if accepted); user disconnects at `/connections`; revoking the assistant at login | Browser test |
| Expired or revoked upstream tokens loop | One refresh attempt per call; then "reconnect" state and a clear error | Unit tests |
| Data left behind after account deletion | `AccountEvents.deleteUser`, retried by login until it succeeds; idempotent | Unit test; login's admin view |
| Abuse and cost (many calls, large results) | Per-user and per-network rate limits; timeouts; response-size caps | Unit tests |
| Clickjacking or XSS on `/connections` | CSP without scripts, `frame-ancestors 'none'`, escaped output, same headers as login | Header tests |
| Supply chain (MCP SDK, OAuth library) | Exact versions, 24 h release delay, Dependabot, CodeQL, lockfile | CI |

## Residual risks (proposed)

- **Prompt injection** through upstream content stays possible. It is a property of letting a
  model read third-party data.
- **Upstream providers** see the gateway's IP and the user's actions on their own service, under
  their own terms.
- **A compromise of the Worker or of `UPSTREAM_TOKEN_KEY`** exposes every stored upstream token.
  Mitigation: the key is only in the production environment; tokens are scoped as narrowly as
  each upstream allows.
