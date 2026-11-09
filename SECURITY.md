# Security Policy

This repository contains the 2earl MCP gateway: an OAuth-protected MCP server that also holds
users' credentials for the MCP servers they connect.
Please do **not** report security vulnerabilities through public issues, discussions or pull requests.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:
**Security → Report a vulnerability** on this repository.

Include as much of the following as you can:

- affected endpoint, flow or component
- steps to reproduce or a proof of concept
- impact you believe it has

You will receive an acknowledgement after the report is reviewed. Please allow time for a fix
before any public disclosure.

## Scope

In scope: the code in this repository and its deployment at `mcp.2earl.com`. Sign-in and tokens
are issued by [2earl/login](https://github.com/2earl/login); report issues there in that repository.

Out of scope: denial-of-service through volumetric traffic, social engineering, and findings in
third-party services (Cloudflare, GitHub, and the MCP servers users connect).
