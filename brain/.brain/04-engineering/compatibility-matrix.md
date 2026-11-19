---
id: COMPATIBILITY-MATRIX
title: "Matriz de Compatibilidade de Infraestrutura, Bancos e Protocolos"
status: approved
type: compatibility_matrix
layer: architecture
access_policy: internal-project
tags:
  - layer:architecture
  - compatibility
  - matrix
  - versions
---

# Matriz de Compatibilidade do Brain OS

Versões mínimas testadas, compatibilidade retroativa e requisitos de runtime:

| Componente | Versão Suportada | Protocolo / Interface | Observações |
| :--- | :--- | :--- | :--- |
| **PostgreSQL** | 16.0+ | SQL / `pgvector` 0.7+ | Índices HNSW (`vector_cosine_ops`), RLS e particionamento |
| **Valkey** | 8.0+ | Redis 7.2 RESP3 / RESP2 | Cache distribuído via `ValkeyRetrievalCache` (:6379) |
| **MinIO** | RELEASE.2024+ | AWS S3 API v4 | Armazenamento de blobs e snapshots (:9000/:9001) |
| **Ollama** | 0.3.0+ | HTTP JSON REST (:11434) | Modelos locais: `gemma2:2b`, `nomic-embed-text` |
| **Bun** | 1.1.20+ | Runtime JavaScript / TypeScript | Execução do Worker e scripts CLI de build |
| **Node.js** | 22 LTS | Runtime JavaScript | Nitro Server (`node-server` preset no Nuxt 4) |
| **Model Context Protocol (MCP)** | Spec 2024-11-05 | JSON-RPC 2.0 / Streamable HTTP | Suporta sessões multiplexadas (`mcp-session-id`) |

## Regras de Compatibilidade
1. **Database Backward Compatibility**: Migrações no PostgreSQL devem ser não destrutivas (`ADD COLUMN IF NOT EXISTS`, sem alteração de tipos que exijam lock exclusivo de tabela).
2. **API Backward Compatibility**: Endpoints na rota `/v1/*` devem manter estabilidade de payload de retorno.
3. **MCP Tool Compatibility**: Novas opções em ferramentas existentes devem ser opcionais (`.optional()`).
