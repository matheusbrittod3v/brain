# Project Brain OS 2.0

> **Um cérebro universal para projetos, negócios e agentes de IA.**  
> Plataforma central de inteligência e memória organizacional que funciona de forma integrada dentro das IDEs e agentes que você já utiliza — **Antigravity, Codex, Kiro, Cursor, Claude Code, VS Code** e outras ferramentas.

O **Project Brain OS 2.0** conecta código, arquitetura, regras de negócio, decisões históricas, tarefas e continuidade de sessão em uma base rastreável e governada. Sua premissa central é simples: **ele não substitui nenhuma IDE ou agente**; ele atua como o cérebro independente e compartilhado que todos consultam via **Plugin, MCP (`stdio` local ou HTTP remoto) ou CLI**, funcionando tanto em modo **Local-First (Docker / CLI)** quanto em **Nuvem (Multi-Tenant)**. Assim, você pode começar um projeto no **Antigravity**, continuar a implementação no **Codex** e validar no **Kiro**, sem explicar novamente a arquitetura, as regras ou o estado das tarefas.

---

## Os 6 Pilares da Plataforma (2.0)

1. **Engineering** — Código, símbolos (AST/LSP), arquitetura, padrões e dependências entre repositórios.
2. **Business** — Produto, regras comerciais, processos, requisitos, clientes e indicadores.
3. **Agent** — Memória em 5 camadas, sessões e continuidade universal entre agentes (*Agent Handoff*).
4. **Execution** — Backlog, épicos, tarefas, critérios de aceite, bloqueios e entregas.
5. **Intelligence** — Autodiscovery, análise de impacto, saúde do conhecimento, conhecimento temporal e otimização de contexto.
6. **Governance** — Permissões pré-recuperação, guardiões de arquitetura/negócio, aprovações humanas e auditoria.

### Arquitetura de Módulos do Produto Completo

| Camada | Módulo | Papel no Produto |
| :--- | :--- | :--- |
| **Núcleo Base** | **MCP Universal** | Servidor de contexto único (14 tools atualmente no catálogo extensível) para diferentes agentes e IDEs |
| **Núcleo Base** | **Project Autodiscovery** | Mapeamento automático de repositórios, stack, microsserviços e arquitetura |
| **Núcleo Base** | **Business Rule Engine** | Regras de negócio versionadas, auditáveis e rastreáveis via `@brain-rule` |
| **Núcleo Base** | **Agent Handoff** | Continuidade real de código e tarefas entre IDEs, máquinas e sessões |
| **Plataforma** | **Knowledge Graph** | Relações tipadas intra e cross-microsserviços (`CONSUMES_API`, `PUBLISHES_EVENT`, etc.) |
| **Plataforma** | **Architecture & Rule Guardians** | Validação automática de mudanças, PRs, segurança e padrões no CI |
| **Plataforma** | **Command Center & Brain Runner** | Dashboard corporativo (Dev, CTO, DevOps, QA, AppSec) + subagente leve com fila/cron |
| **Inteligência Avançada** | **Project Simulator & Temporal** | Simulação de cenários/impactos distribuídos e histórico temporal por commit |

---

## Índice Organizado do Blueprint (Ordem de Leitura Recomendada)

### 1. Visão, Normas & Arquitetura Central
| Documento | Descrição |
| :--- | :--- |
| [00. Decisões Normativas Mestras](docs/00-normative-decisions.md) | **Fonte normativa superior:** resolve todas as decisões de arquitetura, dados, segurança, Edge e operação do produto completo. |
| [01. Visão Geral do Sistema](docs/01-architecture/system-overview.md) | Arquitetura 2.0 (6 pilares + Universal Agent Gateway), os 12 domínios e estrutura de diretórios. |
| [02. Modelo de Dados e Grafo](docs/01-architecture/data-model-and-graph.md) | Entidades tipadas, contrato `KnowledgeItem`, PostgreSQL FTS + `pgvector` + Grafo, RLS e ontologia. |
| [03. Recuperação e Memória](docs/01-architecture/retrieval-and-memory.md) | *Context Router*, busca híbrida, *Federated Context Pack*, *Context Hit Rate* e memória em 5 camadas. |
| [04. Gateway de IDEs e Continuidade](docs/01-architecture/ide-gateway-and-continuity.md) | Integração com Antigravity, Codex, Kiro, Cursor, Claude Code, VS Code e o **Agent Continuity Protocol**. |
| [05. Arquitetura Híbrida (Edge Offline ↔ Hub Online)](docs/01-architecture/hybrid-edge-sync.md) | Sincronização por cargo/setor (`brain sync pull/push`), SQLite offline com IA local opcional, *Local Staging* e *Policy Revocation*. |

### 2. Especificações Funcionais & Contratos
| Documento | Descrição |
| :--- | :--- |
| [06. Especificação de API, MCP e Protocolos](docs/02-specifications/mcp-and-api-spec.md) | As ferramentas MCP documentadas no catálogo extensível (`brain_*`), CLI, endpoints REST e contratos em `protocols/`. |
| [07. Capacidades 2.0 e Command Center](docs/02-specifications/capabilities-and-command-center.md) | As 10 novas funcionalidades (Autodiscovery, Guardians, Temporal, etc.), Dashboard e visão de futuro. |
| [08. Perfis, Microsserviços e Blueprinting](docs/02-specifications/enterprise-roles-and-microservices.md) | Valor para Devs, CTO, DevOps, QA e AppSec; *Cross-Service Registry*, *Federated Context Pack* e `brain scaffold`. |
| [09. Connector Framework e Integrações](docs/02-specifications/connector-framework-and-integrations.md) | Framework de conectores incrementais, repos online no GitHub e matriz de integrações. |
| [10. Brain Runner (Subagente Leve)](docs/02-specifications/brain-runner-subagent.md) | Subagente assíncrono (`brain runner up --local`), fila/cron SQLite no Edge, `pg-boss` no Hub e provedores de IA opcionais. |
| [11. Guia de Estrutura de Conhecimento](docs/02-specifications/knowledge-structure-guide.md) | Fonte da verdade Git vs. Postgres, `.brain/` vs. repo central, *Bootstrap Assistido* e âncoras `@brain-rule`. |

### 3. Segurança, Construção & Riscos
| Documento | Descrição |
| :--- | :--- |
| [12. Segurança e Governança](docs/03-security-and-governance/security-architecture.md) | Isolamento multi-tenant, RBAC/ABAC pré-recuperação, Edge Sync, *prompt injection*, auditoria e LGPD. |
| [13. Blueprint de Construção](docs/04-roadmap/construction-blueprint.md) | Ordem exata de construção em 6 estágios, grafo de dependências entre camadas e padrões de resiliência. |
| [14. Matriz de Riscos e Falhas](docs/04-roadmap/risks-failure-modes-and-mitigations.md) | Falhas esperadas (sync, latência, patch, segurança, adoção), sintomas, causas e mitigações. |
| [15. Roadmap de Implementação](docs/04-roadmap/implementation-roadmap.md) | Plano em 5 fases alinhado às prioridades de produto, backlog e critérios de aceite. |
| [16. Stack Tecnológica e Ambiente Local](docs/04-roadmap/local-dev-and-stack.md) | Decisões *PostgreSQL-first*, modos Local Edge / Docker / Nuvem, Docker Compose e testes. |
| [17. Blocos Open-Source e Bibliotecas](docs/04-roadmap/open-source-building-blocks.md) | Matriz *Zero-Cost / Open-Source First*: libs embutidas, projetos para adaptar e infra self-hosted. |
