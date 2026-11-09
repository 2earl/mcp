# IDs the Worker needs in wrangler.jsonc. None of these are secrets.

output "d1_database_id" {
  description = "wrangler.jsonc → d1_databases[].database_id"
  value       = cloudflare_d1_database.mcp.id
}
