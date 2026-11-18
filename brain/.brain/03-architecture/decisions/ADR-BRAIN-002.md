---
id: ADR-BRAIN-002
type: architecture_decision
title: Separação de Camadas L5->L0 e Thin Adapters em apps/
status: approved
access_policy: internal-project
trust_level: verified
tags: [architecture, layers, monorepo, node-ts, typescript]
---

# Contexto

O monorepo possui múltiplos pontos de entrada (`apps/api`, `apps/cli`, `apps/mcp-server`, `apps/worker`, `apps/agent-runner`, `apps/web`) que compartilham regras de negócio, contratos e persistência.

# Decisão

1. **Contratos puros em `packages/core`:** sem dependências de infraestrutura ou outros pacotes internos (`core-must-be-pure` validado pelo `dependency-cruiser`).
2. **Lógica de domínio em `packages/*`:** cada domínio (`knowledge`, `retrieval`, `graph`, `approval-engine`, `memory`, `task-engine`, etc.) encapsula suas regras e testes unitários.
3. **`apps/*` como *thin adapters*:** `apps/api`, `apps/cli`, `apps/mcp-server` e `apps/web` validam entrada/autenticação, aplicam OPA/RLS e delegam para os pacotes de domínio.
4. **Protocolos versionados em `protocols/`:** JSON Schemas canônicos para `context-pack`, `agent-handoff`, `knowledge-events`, `project-manifest`, `runner-tasks` e `edge-sync`.

