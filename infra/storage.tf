# The gateway's database (docs/DESIGN.md §8): tool pins and the security log. Restricted to the
# EU jurisdiction, which can only be chosen at creation and never changed afterwards.
#
# prevent_destroy: replacing it deletes the security log and every tool approval. If a plan ever
# wants to replace it, stop and investigate instead of removing this guard.
resource "cloudflare_d1_database" "mcp" {
  account_id   = var.account_id
  name         = "mcp"
  jurisdiction = "eu"

  # Read replicas outside the EU would defeat the jurisdiction choice.
  read_replication = {
    mode = "disabled"
  }

  lifecycle {
    prevent_destroy = true
  }
}
