# infra

Terraform for the Cloudflare resources around the `mcp` Worker. Rationale:
[docs/DESIGN.md §10](../docs/DESIGN.md).

| File | Manages |
|---|---|
| `storage.tf` | D1 database `mcp`, EU jurisdiction, protected from destroy |
| `worker.tf` | Custom domain `mcp.2earl.com` → Worker `mcp` (once `attach_custom_domain` is true) |
| `zone.tf` | Reads the 2earl.com zone. Its settings belong to 2earl/login's Terraform |

## How changes are applied

1. Open a PR that changes files here. HCP Terraform (workspace `2earl-mcp`, working directory
   `infra`) posts a speculative plan on the PR.
2. Merge. HCP queues a run on `main`.
3. The owner reviews the plan in HCP and confirms the apply. Apply is never automatic.

Credentials: `CLOUDFLARE_API_TOKEN` is a sensitive environment variable in the workspace. Nothing
in this directory may contain a secret.

## First deployment

A custom domain needs an existing Worker, and the Worker needs the database's ID. So:

1. Merge the PR that adds this directory. Confirm the HCP apply: it creates the D1 database only.
   Don't approve the `deploy` run it starts; it stops by itself while `wrangler.jsonc` has the
   placeholder database ID.
2. A second PR puts the `d1_database_id` output into `wrangler.jsonc` and sets
   `attach_custom_domain` to `true`. After merging it:
   1. approve the `deploy` run and wait until its "Apply D1 migrations, then deploy Worker" step
      has finished (the Worker now exists);
   2. confirm the HCP apply (the custom domain). The deploy's smoke test waits up to ten minutes
      for `https://mcp.2earl.com/healthz`.

## Not managed here

- Worker code, D1 migrations: Wrangler, through `.github/workflows/deploy.yml`.
- The 2earl.com zone, its settings and the zone's WAF and rate-limiting rules: 2earl/login.
