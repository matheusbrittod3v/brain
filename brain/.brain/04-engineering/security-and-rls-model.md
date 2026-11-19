---
id: SEC-BRAIN-RLS
title: Modelo de Segurança, Autenticação OAuth 2.1 e RLS PostgreSQL
type: spec
status: approved
access_policy: internal-project
knowledgeLayer: code
---

# Segurança em Camadas

1. **Autenticação**:
   - Usuários humanos: Argon2id + JWT HS256 (`issueUserJwt` / `verifyUserJwt`).
   - Agentes & IDEs via MCP: OAuth 2.1 PKCE (`/oauth/register` + `/oauth/token` com rotação de `refresh_token`), Device Flow 1-clique (`/v1/auth/oauth/pending`) e tokens revogáveis (`auth_mcp_tokens` com `sha256(token)`).
2. **Autorização & RLS**:
   - `registerRbacGuard` protege rotas REST; `/mcp` usa `registerMcpGatewayRoutes` com desafio `401 WWW-Authenticate`.
   - `withTenantRls` injeta `app.current_tenant_id`, `app.allowed_projects` e `app.allowed_policies` na transação PostgreSQL (`brain_app`).
   - Descoberta dinâmica de projetos usa `systemDb` (`DATABASE_SYSTEM_URL`) para resolver novos projetos antes de aplicar o escopo RLS da sessão.
