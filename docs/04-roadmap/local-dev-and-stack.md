# Stack Padrão, Custo de Operação e Ambiente Local

## 1. Stack Padrão Oficial (Com Classificação de Necessidade)

> **Princípio de Simplicidade Operacional:** O núcleo do **Project Brain OS 2.0** roda sobre **TypeScript + Fastify + PostgreSQL (`pgvector` + `pg-boss` + Drizzle)**, reduzindo o número de serviços obrigatórios. Componentes pesados entram apenas quando o fluxo correspondente é ativado.

| Camada | Stack Padrão (Versão) | Alternativa Aceita | Status |
| :--- | :--- | :--- | :--- |
| **API & Validação** | TypeScript + Fastify + TypeBox (JSON Schema) | Zod onde útil | **Obrigatória** |
| **Contratos Canônicos** | JSON Schema (`protocols/`) gerando tipos TS | — | **Obrigatória** |
| **Banco, Vetores & RLS** | PostgreSQL 16 + `pgvector >= 0.8` + Drizzle ORM (`packages/database`) | ParadeDB (`pg_search` BM25) | **Obrigatória** |
| **Busca Lexical** | PostgreSQL FTS nativo | ParadeDB BM25 (upgrade drop-in) | **Obrigatória** |
| **Fila & Cron (Hub)** | **`pg-boss`** (sobre o próprio PostgreSQL) | Temporal.io para workflows longos | **Obrigatória no Hub** |
| **Integração com Agentes** | `@modelcontextprotocol/sdk` (`stdio` + `Streamable HTTP`) | CLI (`brain`) | **Obrigatória** |
| **Análise de Código & CI** | `web-tree-sitter` + Semgrep + `dependency-cruiser` | Sourcegraph SCIP (semântica avançada) | **Obrigatória** |
| **Observabilidade** | OpenTelemetry | Langfuse (traces/custo de IA) | **Obrigatória** |
| **Embeddings & LLM Local** | Ollama (`bge-m3` 1024d) | Provedores externos via `LiteLLM` | **Opcional** |
| **Auth Corporativa** | API Key local + RLS (dev/single) / Keycloak + OPA (corporativo) | — | **Opcional (Nuvem)** |
| **Docs Complexos & PII** | `apps/ai-worker` Python (`Docling` + `Presidio`); rota autenticada de ingestão de documentos converte PDF/DOCX/PPTX/XLSX/HTML/CSV em Markdown antes dos gates de segredo, PII, OPA e persistência; `AI_WORKER_URL` habilita sanitização nos demais fluxos REST/Edge/Git/SaaS | — | **Sob Demanda**; limite de 16 MiB; OCR de scans reais ainda sem avaliação; fallback de PII limitado a emails/CPF |
| **Dashboard & Storage** | Next.js (`apps/web`) + MinIO (patches/arquivos grandes) | — | **Sob Demanda** |
| **Conectores SaaS** | API oficial GitHub + Webhooks | Nango (quando houver 2+ SaaS OAuth) | **Sob Demanda** |

### Fluxo de Referência (Prova Arquitetural End-to-End)
`Ingerir Markdown/Git` → `Indexar (PG FTS + pgvector)` → `Buscar com permissões (RLS/OPA)` → `Retornar Context Pack com citações e sources[]`.

### Tabela de Custo de Operação (Estimativa de Infraestrutura)

| Perfil | Serviços Obrigatórios | RAM / Disco Aproximados | Modelo Local |
| :--- | :--- | :--- | :--- |
| **Local Edge (Offline)** | CLI Node/TS + SQLite (`FTS5`; `sqlite-vec` opcional) + fila SQLite | `~150 MB RAM` / `~200 MB` disco | Ollama opcional (+2–4 GB RAM, conforme modelo) |
| **Hub Enxuto (Base)** | `PostgreSQL 16 (pgvector + pg-boss)` + `apps/api` + `apps/worker` | `~1.5–2 GB RAM` / `~5 GB` disco | Opcional (Ollama `bge-m3`: +2 GB RAM) |
| **Hub Completo (`--profile full`)** | Base + `MinIO`, `Temporal`, `Keycloak`, `OPA`, `Nango`, `Langfuse`, `ai-worker`, `web` | `~8–12 GB RAM` / `~25 GB` disco | Opcional (GPU/CPU dedicada) |

---

## 2. Modos de Execução: Local Edge, Single-Node e Nuvem Corporativa

O **Project Brain OS 2.0** foi desenhado para rodar tanto offline na máquina de cada funcionário quanto em infraestrutura compartilhada, mantendo os mesmos contratos MCP, CLI e REST:

| Modo | Como Sobe | Autenticação | Uso Ideal |
| :--- | :--- | :--- | :--- |
| **Local Edge (Offline-First)** | CLI + SQLCipher/SQLite (`FTS5`; `sqlite-vec` opcional) + fila SQLite; Ollama opcional | Chave aleatória do banco no keychain; lease offline quando configurado | Trabalho offline, rascunhos privados e baixa latência via `brain sync pull/push`; smoke test SQLCipher cobre macOS local e há matriz CI configurada para Ubuntu/macOS/Windows; Linux/Windows aguardam resultados aprovados antes de suporte validado |
| **Local-First (Single-Node Docker)** | PostgreSQL 16 (`pgvector` + `pg-boss`) + `apps/api` + `apps/worker`; serviços adicionais opcionais | API Key local + RLS | Desenvolvimento do sistema ou servidor local de time |
| **Enterprise Hub (Nuvem Multi-Tenant)** | Docker / Kubernetes (`infra/kubernetes/`) + Terraform (`infra/terraform/`); serviços extras conforme fluxo | Keycloak (OIDC) + OPA (RBAC/ABAC) | Uso corporativo multi-time, Command Center, CI Guardians e conectores SaaS |

### Uso via Plugin, MCP e CLI em Qualquer Harness de IA
- **Via MCP (`stdio` local ou `Streamable HTTP` remoto):** plugável diretamente em Antigravity, Codex, Kiro, Cursor, Claude Code, Windsurf, Continue e Cline (com `brain mcp connect <url>` como bridge `stdio` para clientes que só suportam transporte local).
- **Via CLI (`brain`):** utilizável por qualquer agente ou funcionário (`brain init`, `brain sync pull`, `brain sync push`, `brain context build`, `brain context explain`, `brain handoff create`, `brain handoff checkout`, `brain export`, `brain import`, `brain validate`, `brain scaffold`, `brain migrate`).
- **Portabilidade & Zero Lock-in (`.brainpack`):** `brain export` gera um pacote portátil (`tar.zst` com JSONL de entidades, arestas do grafo, `.brain/` e manifesto SHA-256, sem embeddings pesados) para backup frio, migração ou compartilhamento offline; `brain import` restaura e reindexa localmente ou em outro servidor.
- **Via Plugins / Extensões:** painel nativo em VS Code (`apps/ide-extension-vscode`) e JetBrains (`apps/ide-plugin-jetbrains`).
- **Ambientes Corporativos & Fallback Local:** suporte nativo a `HTTP_PROXY` / `HTTPS_PROXY`, certificados privados (`NODE_EXTRA_CA_CERTS`), conectores GitLab Self-Hosted / Bitbucket Server e fallback automático para SQLite FTS5 puro caso a extensão nativa `sqlite-vec` não esteja disponível na máquina.

---

## 2.1 Compatibilidade Cross-Platform (Windows, Linux e macOS)

Os componentes locais (`apps/cli`, `apps/mcp-server` stdio e `Local Edge Brain`) devem rodar nativamente em **Windows (x64/WSL2), Linux (x64/ARM64) e macOS (Intel/Apple Silicon)**. O Runner local é um módulo da CLI, não um daemon separado:

1. **Normalização de Caminhos e Line Endings:** Todos os `sourceUri`, `modifiedFiles` (no `Agent Handoff`) e chaves no Knowledge Graph são normalizados para formato POSIX (`/`) e `LF`, evitando que `\` (Windows) ou `CRLF` quebrem hashes e comparações com Linux/macOS.
2. **Zero Dependência de Shell Unix:** A CLI e os scripts internos usam Node.js/TypeScript puro em vez de depender de `bash`, `grep` ou `sed`, funcionando igualmente em **PowerShell, cmd, zsh e bash**.
3. **Binários e Containers por Arquitetura:** Distribuição multi-arch (`win32-x64`, `linux-x64`, `linux-arm64`, `darwin-arm64`) para CLI/Gitleaks e suporte a Docker Desktop / WSL2 (Windows), Docker Engine (Linux) e OrbStack / Docker Desktop (macOS), com `brain doctor` para diagnosticar ambiente, SQLite e serviços opcionais.

---

## 3. Infraestrutura Local (`infra/docker/`)

Para desenvolvimento local, o `docker compose up` sobe **PostgreSQL 16 (`pgvector` + `pg-boss`)**. `apps/api` e `apps/worker` podem rodar via Node/TypeScript ou em containers. Ollama fica no perfil opcional `local-ai`; MinIO, Valkey, Temporal.io, Keycloak, OPA, Nango, Langfuse, `apps/ai-worker` e `apps/web` ficam disponíveis via `--profile full`.

### Topologia Oficial & SLOs de Operação
- **Núcleo Enxuto do Hub:** `apps/api` (Fastify + TypeBox: REST + `/mcp` HTTP + `/gateway`), `apps/worker` (TypeScript + `pg-boss` sobre PostgreSQL) e `PostgreSQL 16 + pgvector`. Serviços como `apps/web`, `apps/ai-worker`, `Temporal`, `MinIO` e `Keycloak` entram via `--profile full` ou sob demanda por fluxo.
- **Dependência do Ingestion Gate:** o executável `gitleaks` deve estar instalado nos ambientes da API e do worker. O scanner é obrigatório antes de gravar conteúdo; se não estiver disponível, a API responde `503` e o worker registra erro por arquivo sem persistir esse conteúdo.
- **Hardware de Referência & Hipóteses de SLO:** 4 vCPU / 16 GB RAM para o Hub base; metas p95 (`< 150ms` lexical, `< 800ms` híbrida, `< 2s` Context Pack) são **hipóteses** sujeitas a benchmark reproduzível com consulta vetorial exata filtrada por RLS. HNSW só entra após validação de isolamento e ranking.
- **Disponibilidade & Recuperação:** `99.5%` mensal (excluindo janelas programadas), `RPO = 1h` e `RTO = 4h` validados via simulação trimestral de restore.

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_USER: brain
      POSTGRES_PASSWORD: brain_dev_password
      POSTGRES_DB: project_brain_os
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

  ollama:
    image: ollama/ollama:<versao-fixada>
    profiles: ["local-ai", "full"]
    ports:
      - "11434:11434"
    volumes:
      - ollamadata:/root/.ollama

  minio:
    image: minio/minio:<versao-fixada>
    profiles: ["full"]
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: brain_minio
      MINIO_ROOT_PASSWORD: brain_minio_password
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - miniodata:/data

volumes:
  pgdata:
  ollamadata:
  miniodata:
```

---

## 4. Estratégia de Testes (`tests/`)

| Diretório | Escopo | O que valida |
| :--- | :--- | :--- |
| `tests/unit/` | Rápido / Isolado | Regras de negócio, parser de YAML/MD, montador de `Context Pack`, cálculo de orçamento de tokens |
| `tests/integration/` | Com Docker (PostgreSQL + `pgvector` + `pg-boss`) | Ingestão incremental, queries híbridas, transações no grafo e jobs |
| `tests/retrieval-evals/` | Qualidade de IA | Dataset dourado de perguntas vs. `Context Packs` esperados (Precision, Recall, citações) |
| `tests/security/` | Segurança e Isolamento | Tentativas de acesso cross-tenant, vazamento em busca vetorial e bypass de aprovação |

