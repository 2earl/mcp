# The 2earl.com zone and its settings (TLS, HSTS, 0-RTT off, DNSSEC) are managed by
# 2earl/login's Terraform. Here it is only read, so nothing in this repository can change them.
data "cloudflare_zone" "this" {
  filter = {
    name    = var.zone_name
    account = { id = var.account_id }
  }
}
