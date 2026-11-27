# infra

Terraform for the Cloudflare resources around the `mcp` Worker. Rationale:
[docs/DESIGN.md §10](../docs/DESIGN.md).

| File | Manages |
|---|---|
| `storage.tf` | D1 database `mcp`, EU jurisdiction, protected from destroy |
| `worker.tf` | Custom domain `mcp.2earl.com` → Worker `mcp` (once `attach_custom_domain` is true) |
| `zone.tf` | Reads the 2earl.com zone. Its settings belong to 2earl/login's Terraform |

## How changes are applied

HCP Terraform (workspace `2earl-mcp`) keeps the state only; Terraform runs in GitHub Actions
(`.github/workflows/infra.yml`), so a run never depends on HCP fetching the repository.

1. Open a PR that changes files here. The `check` job runs `terraform fmt`, `init` and
   `validate`, without secrets.
2. Merge. On `main`, the `plan` job waits for the owner's approval (environment `production`),
   then writes the plan to the run's summary.
3. If there are changes, the `apply` job waits for a second approval and applies only if a fresh
   plan is identical to the one reviewed. Apply is never automatic.

Credentials, in the repository's `production` environment: `TF_API_TOKEN` (an HCP Terraform team
token) and `CLOUDFLARE_INFRA_API_TOKEN`. Nothing in this directory may contain a secret.

## First deployment

A custom domain needs an existing Worker, and the Worker needs the database's ID. So:

1. Merge the PR that adds this directory. Approve the `infra` run: it creates the D1 database only.
   Don't approve the `deploy` run it starts; it stops by itself while `wrangler.jsonc` has the
   placeholder database ID.
2. A second PR puts the `d1_database_id` output into `wrangler.jsonc` and sets
   `attach_custom_domain` to `true`. After merging it:
   1. approve the `deploy` run and wait until its "Apply D1 migrations, then deploy Worker" step
      has finished (the Worker now exists);
   2. approve the `infra` run (the custom domain). The deploy's smoke test waits up to ten minutes
      for `https://mcp.2earl.com/healthz`.

## Not managed here

- Worker code, D1 migrations: Wrangler, through `.github/workflows/deploy.yml`.
- The 2earl.com zone, its settings and the zone's WAF and rate-limiting rules: 2earl/login.
