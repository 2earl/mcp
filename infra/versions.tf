terraform {
  required_version = ">= 1.10.0"

  # State and runs live in HCP Terraform. The workspace is VCS-driven from this repo
  # (working directory "infra", manual apply).
  cloud {
    organization = "2earl"
    workspaces {
      name = "2earl-mcp"
    }
  }

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28"
    }
  }
}
