# Brain — Project Brain OS 2.0

Use sempre o MCP Brain antes de editar código crítico. O catálogo é extensível; atualmente há **108+ ferramentas MCP**. Documente cada ferramenta nova ou alterada em `.brain/06-operations/mcp-tools-catalog.md` e `.brain/04-engineering/api-and-mcp-contracts.md`, mantendo `protocols/mcp-tools/catalog.json`, paridade HTTP/stdio e testes de autorização alinhados:
1. `brain_context_build` para montar o Context Pack da tarefa.
2. `brain_validate_implementation` antes de concluir alterações em regras de negócio.
3. `brain_create_handoff` / `brain_resume_handoff` para continuidade cross-IDE.
4. `brain_list_skills` / `brain_get_skill` ou `.brain/skills/` para carregar as skills oficiais de engenharia (`git-workflow-craftsman`, `code-elegance-avoid-if-else`, `frontend-architecture-craft`, `backend-resilience-craft`, `fullstack-testing-strategy`, `modern-language-features`, `brain-mcp-advisor`, `brain-knowledge-hygiene`).

## MCP principal e MCP local (mesmo motor, modos distintos)

- Os dois MCPs executam o **mesmo código/motor** sobre **Bun + Turborepo**; o que muda é o **ambiente de execução** (`BRAIN_DEPLOYMENT_MODE=local|cloud`) e o transporte:
  - `brain` / **Brain principal** (`http://localhost:3333/mcp` · Streamable HTTP): conecta no servidor compartilhado pelo time (nuvem/rede ou instância principal subindo com `bun run start:cloud` ou `bun run init:start`), usando a identidade, escopos e backend desse serviço.
  - `brain_local` / **Brain local** (`stdio` · `bun run start:local`): roda na máquina do agente, herda o `.env` local e acessa o checkout/arquivos locais. Pode operar **solo** na sua máquina/rede ou como **espaço offline (Edge)** sincronizado sob demanda via `brain sync pull` / `brain sync push` com qualquer servidor em nuvem.
- As descrições das ferramentas começam com o perfil da conexão. Leia esse prefixo antes de uma operação que grava dados.
- O rótulo `local` descreve onde o processo roda; se `DATABASE_URL` local apontar para a mesma base usada pelo serviço HTTP, os dados serão compartilhados diretamente em vez de isolados. Também não assuma sincronização automática entre bases distintas sem `pull`/`push`.
- Nesta configuração, os dois perfis retornaram o mesmo registro do projeto `brain` (`tenantId` e `createdAt`) e o mesmo item episódico. Isso confirma sobreposição dos dados observados, mas não identifica a configuração física do banco. Se o projeto não aparecer numa conexão, verifique `projectId`, tenant e escopos nela antes de criar outro registro.

## Inicialização e consumo da pasta `.brain/`

Se o repositório conectado ainda não tiver `.project-brain.json` e `.brain/`, crie-os antes de iniciar tarefas estruturais (via `brain onboard` / `brain init` ou manualmente):

- **Manifesto raiz**: `.project-brain.json` (`schemaVersion`, `tenantId`, `projectId`, `knowledgeRoot: ".brain/"`, `guardianMode`, `accessPolicyId`).
- **Pastas importantes em `.brain/`**:
  - `.brain/00-overview/vision.md` — visão, objetivo e domínio do projeto (`VIS-<PROJETO>`).
  - `.brain/01-business/business-rules/*.yaml` — regras de negócio e invariantes (`id: BR-...`, `type: business_rule`, `status`, `access_policy`, `description`).
  - `.brain/02-onboarding/guide.md` — mapa do repositório, preparação local e fluxo de mudança.
  - `.brain/03-architecture/decisions/ADR-*.md` — decisões arquiteturais com frontmatter (`id`, `title`, `status`, `access_policy`).
  - `.brain/04-engineering/` (`coding-standards.md`, `security-standards.md`) — padrões de código, segurança, PII e restrições técnicas.

### Como funciona
1. `.brain/` é a fonte de verdade versionada em Git; os arquivos `.md` e `.yaml` são ingeridos e indexados no PostgreSQL (FTS + `pgvector` + grafo) via `brain_ingest_git`, `brain_ingest_document`, `brain_propose_knowledge`, `brain sync` ou webhook do GitHub.
2. Uma vez indexados, os agentes consomem o conhecimento via `brain_context_build`, validam código contra regras e ADRs via `brain_validate_implementation` e registram continuidade entre sessões via `brain_create_handoff` / `brain_resume_handoff`.

<!-- BRAIN:MCP:START -->
## Brain MCP — Uso Obrigatório & Conselheiro de Projeto

Quando o servidor MCP **brain** estiver disponível nesta sessão, **use-o sempre que possível** para economizar tokens, evitar retrabalho e manter o conhecimento atualizado:

1. **Início da tarefa**: chame `brain_resolve_workspace_project` para detectar o `projectId`, depois consulte `brain_context_build`, `brain_get_active_rules` e `brain_search` para aproveitar regras, topologias, contratos e decisões já prontas.
2. **Antes de concluir**: valide contra invariantes com `brain_validate_implementation`, avalie impacto com `brain_analyze_change_impact` e verifique segredos com `brain_secret_scan`.
3. **Ao finalizar**: atualize o Brain com `brain_ingest_git_repo` (se alterou `.brain/`), `brain_record_test_result`, `brain_record_learning` e `brain_create_handoff`.
<!-- BRAIN:MCP:END -->
