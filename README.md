# Brain (Project Brain OS)

Cérebro universal para engenharia de software, regras de negócio, topologias em camadas e agentes de IA — centralizado em **`.brain/`** (versionado em Git) e indexado no **PostgreSQL 16 + `pgvector` + Grafo** com acesso via **Web UI**, **API REST** e **MCP (Streamable HTTP + `stdio`)**.

---

## Documentação Viva (`.brain/`)

Toda a documentação do projeto vive em `brain/.brain/` e é consumida diretamente pelo Brain e pelos agentes via MCP (sem pasta `docs/`):

- **Visão Geral**: [`brain/.brain/00-overview/vision.md`](brain/.brain/00-overview/vision.md)
- **Regras de Negócio**: [`brain/.brain/01-business/business-rules/`](brain/.brain/01-business/business-rules)
- **Onboarding & Setup**: [`brain/.brain/02-onboarding/guide.md`](brain/.brain/02-onboarding/guide.md)
- **Arquitetura, Topologia & Modelo de Dados**:
  - [`brain/.brain/03-architecture/system-topology.md`](brain/.brain/03-architecture/system-topology.md)
  - [`brain/.brain/03-architecture/data-model.md`](brain/.brain/03-architecture/data-model.md)
  - [`brain/.brain/03-architecture/ADR-BRAIN-001-topology-and-auth.md`](brain/.brain/03-architecture/ADR-BRAIN-001-topology-and-auth.md)
- **Padrões de Engenharia**: [`brain/.brain/04-engineering/coding-standards.md`](brain/.brain/04-engineering/coding-standards.md)
- **Fluxos & Protocolos**:
  - [`brain/.brain/05-flows/mcp-oauth-flow.md`](brain/.brain/05-flows/mcp-oauth-flow.md)
  - [`brain/.brain/05-flows/hybrid-retrieval-flow.md`](brain/.brain/05-flows/hybrid-retrieval-flow.md)
- **Operação & Comandos**: [`brain/.brain/06-operations/deployment-and-commands.md`](brain/.brain/06-operations/deployment-and-commands.md)
- **Skills para Agentes**: [`brain/.brain/skills/brain-knowledge-hygiene/SKILL.md`](brain/.brain/skills/brain-knowledge-hygiene/SKILL.md)

---

## Como Subir o Projeto

```bash
cd brain
bun run infra:up                                   # PostgreSQL 16 + pgvector + Valkey
bun --env-file=.env apps/api/src/server.ts         # API + MCP HTTP (:3333/mcp)
cd apps/web && PORT=3000 bun .output/server/index.mjs  # Web UI (:3000)
```

---

## Conectar Agentes via MCP (Codex / Antigravity / Cursor)

- **Via HTTP (OAuth 2.1 PKCE automático ou Bearer Token)**: `http://localhost:3333/mcp`
- **Via `stdio` (login 1-clique)**:
  ```bash
  ~/.bun/bin/bun brain/apps/mcp-server/dist/index.js login
  ```
