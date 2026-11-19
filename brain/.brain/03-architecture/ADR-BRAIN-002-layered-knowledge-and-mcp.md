---
id: ADR-BRAIN-002
title: Conhecimento em Camadas, Diagramas Mermaid e Protocolo MCP Completo
type: architecture_decision
status: approved
access_policy: internal-project
knowledgeLayer: architecture
---

# ADR-BRAIN-002: Conhecimento Multi-Camada e MCP

1. **Camadas de Conhecimento**: Todo item indexado é classificado em `architecture`, `business`, `code`, `flows` ou `data`, com detecção automática de formato (`markdown`, `yaml`, `mermaid`) e score de qualidade.
2. **Protocolo MCP Completo**: O servidor `@brain/mcp-server` expõe **Tools** (busca híbrida, grafo, ingestão, runner, RBAC, FinOps, segurança), **Resources** (`brain://projects/{projectId}/...`) e **Prompts** (`brain-pre-change-check`, `brain-architecture-review`, `brain-handoff-summary`).
3. **Embeddings Automáticos**: Ingestões via MCP enfileiram automaticamente jobs `bge-m3` no `pg-boss` para o `@brain/worker` popular `knowledge_embeddings`.
