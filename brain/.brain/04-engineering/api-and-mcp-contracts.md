---
id: SPEC-BRAIN-CONTRACTS
title: Contratos HTTP da API, OAuth 2.1 PKCE e Gateway MCP
type: spec
status: approved
access_policy: internal-project
knowledgeLayer: code
---

# Contratos Principais (`:3333`)

- `GET /.well-known/oauth-protected-resource` — Metadados RFC 9728 do endpoint `/mcp`.
- `GET /.well-known/oauth-authorization-server` — Metadados RFC 8414 (PKCE + DCR + Device Flow).
- `POST /oauth/register` — Dynamic Client Registration (RFC 7591).
- `POST /oauth/token` — Troca de `authorization_code` (PKCE S256) e rotação de `refresh_token`.
- `POST|GET|DELETE /mcp` — Gateway MCP Streamable HTTP stateful (`Mcp-Session-Id`) com escopo dinâmico PostgreSQL.
- `POST /v1/auth/mcp-token` & `GET|DELETE /v1/auth/mcp-tokens` — Gestão de tokens revogáveis em `auth_mcp_tokens`.
