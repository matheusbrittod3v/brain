---
id: ADR-BRAIN-001
title: Autenticação OAuth 2.1 PKCE e Modularização <= 700 Linhas
type: architecture_decision
status: approved
access_policy: internal-project
knowledgeLayer: architecture
---

# ADR-BRAIN-001: Arquitetura Modular e Autenticação MCP

1. **Modularidade**: Arquivos de código-fonte de produção devem permanecer abaixo de **700 linhas**, organizados por domínio em subpastas.
2. **MCP Auth**: Clientes externos conectam via Streamable HTTP (`/mcp`) ou proxy `stdio` autenticado (`~/.brain/credentials.json`), com Dynamic Client Registration (`/oauth/register`), PKCE (`/oauth/token`) e tokens revogáveis em `auth_mcp_tokens`.
3. **Resolução de Projeto**: Agentes detectam o `projectId` pelo workspace usando `brain_resolve_workspace_project`.
