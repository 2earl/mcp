variable "account_id" {
  description = "Cloudflare account that owns the 2earl.com zone and the mcp Worker."
  type        = string
  # Cloudflare account IDs are identifiers, not credentials.
  default = "304c2b77d734c688c8309d5a535f561a"
}

variable "zone_name" {
  description = "DNS zone the gateway runs in. Read here, managed in 2earl/login's Terraform."
  type        = string
  default     = "2earl.com"
}

variable "hostname" {
  description = "Public hostname of the gateway."
  type        = string
  default     = "mcp.2earl.com"
}

variable "worker_name" {
  description = "Name of the Worker deployed by .github/workflows/deploy.yml (wrangler.jsonc \"name\")."
  type        = string
  default     = "mcp"
}

variable "attach_custom_domain" {
  description = <<-EOT
    Attach the hostname to the Worker. A custom domain can only point at a Worker that exists,
    and the Worker is created by its first deploy, so this stays false until then
    (README.md, "First deployment").
  EOT
  type        = bool
  default     = false
}
