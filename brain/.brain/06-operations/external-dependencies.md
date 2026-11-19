---
id: EXTERNAL-DEPENDENCIES
title: "Catálogo de Dependências de Infraestrutura Externa e Planos de Contingência"
status: approved
type: external_dependency
layer: operations
access_policy: internal-project
tags:
  - layer:operations
  - dependencies
  - infra
  - contingency
---

# Catálogo de Dependências Externas & Planos de Contingência

Mapeamento de serviços essenciais, criticidade, proprietários técnicos e estratégia de fallback:

## 1. PostgreSQL 16 + pgvector (`docker-postgres-1`)
- **Finalidade**: Banco de dados relacional principal, armazenamento de entidades de domínio, grafos e embeddings vetoriais (HNSW).
- **Porta**: 5432
- **Criticidade**: Crítica (P1).
- **Plano de Contingência**: Réplica de leitura em standby; dumps diários automatizados e retenção pontual de WAL.

## 2. Valkey 8 (`docker-valkey-1`)
- **Finalidade**: Cache distribuído para busca híbrida, Context Packs e sessões temporárias.
- **Porta**: 6379
- **Criticidade**: Média (P3).
- **Plano de Contingência**: A classe `ValkeyRetrievalCache` possui chaveamento automático para cache LRU em memória RAM local sem interrupção de serviço.

## 3. MinIO S3 Object Storage (`docker-minio-1`)
- **Finalidade**: Armazenamento durável de snapshots de auditoria, PDFs e artefatos gerados por subagentes do Brain Runner.
- **Portas**: 9000 (API S3) e 9001 (Console Web)
- **Criticidade**: Alta (P2).
- **Plano de Contingência**: Gravação síncrona temporária no diretório `data/artifacts/` do disco local com job de ressincronização em background.

## 4. Ollama Local Engine (`docker-ollama-1`)
- **Finalidade**: Execução de inferência de embeddings locais (`nomic-embed-text`) e submodelos (`gemma2:2b`).
- **Porta**: 11434
- **Criticidade**: Média (P3).
- **Plano de Contingência**: Transição automática para OpenAI API ou Google Gemini API caso o contêiner local esteja sobrecarregado ou pausado.
