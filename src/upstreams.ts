/**
 * Services behind the gateway (docs/DESIGN.md §6). Reviewed code, never user input: the gateway
 * only ever talks to what is listed here (SSRF, THREAT_MODEL.md).
 *
 * First-party services (2earl's own, e.g. prompt-share) are reached over a Service Binding to
 * their `GatewayMcp` entrypoint (docs/UPSTREAM_CONTRACT.md): no public URL, no OAuth between the
 * two, the user's identity passed in headers the service can trust because only Workers in the
 * 2earl Cloudflare account can bind to it.
 */

export interface Upstream {
  /** Tool prefix (`<id>__<tool>`) and scope namespace (`mcp:<id>.*`). */
  id: string;
  /** How the service reads in tool titles and on consent pages. */
  name: string;
  /** Service Binding to the service's `GatewayMcp` entrypoint (wrangler.jsonc). */
  binding: string;
  /**
   * `first-party`: 2earl's own code, reviewed in its own repository. A changed tool is offered at
   * once and audited. `third-party`: a changed tool is hidden until the owner approves it.
   */
  trust: 'first-party' | 'third-party';
  /**
   * The service's permissions, each declared in login's service registry with consent wording.
   * `read` is required for read-only tools and `write` for the rest, unless a tool names one of
   * these scopes itself in `_meta["2earl/scope"]`.
   */
  scopes: { read: string; write: string; [name: string]: string };
}

/** Production list. Each service's scopes are declared, with consent wording, in login's registry. */
export const UPSTREAMS: readonly Upstream[] = [
  {
    // 2earl/promptshare: prompts and shared sessions.
    id: 'promptshare',
    name: 'Prompt share',
    binding: 'PROMPTSHARE',
    trust: 'first-party',
    scopes: {
      read: 'mcp:promptshare.read',
      write: 'mcp:promptshare.write',
      state: 'mcp:promptshare.state',
    },
  },
];

/** Separates the service prefix from the tool name. MCP tool names allow `_`. */
export const PREFIX_SEPARATOR = '__';

export function prefixedName(upstream: Upstream, tool: string): string {
  return `${upstream.id}${PREFIX_SEPARATOR}${tool}`;
}

/** Splits `<id>__<tool>` into its service and tool, or null for anything else. */
export function splitName(
  upstreams: readonly Upstream[],
  name: string,
): { upstream: Upstream; tool: string } | null {
  const at = name.indexOf(PREFIX_SEPARATOR);
  if (at <= 0) return null;
  const upstream = upstreams.find((u) => u.id === name.slice(0, at));
  const tool = name.slice(at + PREFIX_SEPARATOR.length);
  return upstream && tool ? { upstream, tool } : null;
}
