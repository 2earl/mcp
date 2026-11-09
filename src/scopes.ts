import type { Upstream } from './upstreams';

/**
 * The gateway's permissions (docs/DESIGN.md §7). Declared in login's service registry; this is
 * where they are enforced.
 */

/** See which tools exist, across every service. The minimum an assistant asks for first. */
export const TOOLS_READ = 'mcp:tools.read';

/**
 * Scope hierarchy, which MCP requires servers to honour: a service's `write` implies its `read`,
 * and any scope of a service implies seeing which tools exist.
 */
export function has(granted: readonly string[], needed: string, upstreams: readonly Upstream[]) {
  if (granted.includes(needed)) return true;
  for (const upstream of upstreams) {
    const scopes = Object.values(upstream.scopes);
    if (needed === upstream.scopes.read && granted.includes(upstream.scopes.write)) return true;
    if (needed === TOOLS_READ && scopes.some((scope) => granted.includes(scope))) return true;
  }
  return false;
}

/** Of the token's scopes, those that belong to `upstream`: what the service is told. */
export function scopesFor(upstream: Upstream, granted: readonly string[]): string[] {
  const own = new Set(Object.values(upstream.scopes));
  const result = granted.filter((scope) => own.has(scope));
  // Pass the hierarchy on, so a service never has to know it.
  if (result.includes(upstream.scopes.write) && !result.includes(upstream.scopes.read)) {
    result.push(upstream.scopes.read);
  }
  return result;
}

/**
 * The scope a tool needs: one the tool names itself (`_meta["2earl/scope"]`, if it is one of the
 * service's), else `read` for a tool marked read-only and `write` for everything else.
 */
export function requiredScope(
  upstream: Upstream,
  tool: { annotations?: { readOnlyHint?: boolean }; _meta?: Record<string, unknown> },
): string {
  const named = tool._meta?.['2earl/scope'];
  if (typeof named === 'string' && Object.values(upstream.scopes).includes(named)) return named;
  return tool.annotations?.readOnlyHint === true ? upstream.scopes.read : upstream.scopes.write;
}
