# Attaches mcp.2earl.com to the Worker. Cloudflare creates the DNS record and certificate itself.
# The Worker script is created by the deploy workflow, not by Terraform.
resource "cloudflare_workers_custom_domain" "mcp" {
  count = var.attach_custom_domain ? 1 : 0

  account_id = var.account_id
  zone_id    = data.cloudflare_zone.this.id
  hostname   = var.hostname
  service    = var.worker_name
}
