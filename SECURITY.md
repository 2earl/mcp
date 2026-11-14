# Security Policy

This repository contains the 2earl MCP gateway (mcp.2earl.com). It is private and proprietary.

## Reporting a vulnerability

Write to **legal@2earl.com** with "Security" in the subject. The same contact is published at
<https://2earl.com/.well-known/security.txt>. Please don't disclose it before it's fixed.

Include as much of the following as you can:

- affected endpoint, flow or component
- steps to reproduce or a proof of concept
- impact you believe it has

You will receive an acknowledgement after the report is reviewed.

## Scope

In scope: the code in this repository and its deployment at `mcp.2earl.com`. Sign-in and tokens
are issued by 2earl/login; the same address takes reports for it.

Out of scope: denial-of-service through volumetric traffic, social engineering, and findings in
third-party services (Google, Cloudflare, GitHub).
