# mcp

The 2earl MCP gateway, served at `https://mcp.2earl.com/mcp`: one MCP endpoint for AI assistants,
signed in with a 2earl account ([login.2earl.com](https://github.com/2earl/login)). Behind it are
the MCP servers of 2earl's own services, prompt-share first.

**Status:** phase M1 built: authentication through login, `whoami`, the plumbing for services
(Service Bindings, per-service permissions, tool pinning, audit), account deletion and export. Not
deployed yet; see [infra/README.md](infra/README.md#first-deployment).

## Documents

- [Design](docs/DESIGN.md): what it does, architecture, permissions, data, phases
- [Threat model](docs/THREAT_MODEL.md): assets, trust boundaries, threats and controls
- [Upstream contract](docs/UPSTREAM_CONTRACT.md): what a 2earl service implements to appear
  behind the gateway

## Development

```sh
pnpm install
pnpm test        # Workers runtime (vitest + @cloudflare/vitest-plugin)
pnpm typecheck
pnpm lint
pnpm build       # dry-run bundle
```

## Security

Please report vulnerabilities privately. See [SECURITY.md](SECURITY.md).

## License

[AGPL-3.0](LICENSE)
