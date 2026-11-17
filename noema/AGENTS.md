# Noema — Project Brain OS 2.0

Use sempre o MCP Noema antes de editar código crítico. O catálogo é extensível; atualmente há 35 ferramentas. Documente cada ferramenta nova ou alterada em `docs/02-specifications/mcp-and-api-spec.md` e mantenha `protocols/mcp-tools/catalog.json`, paridade HTTP/stdio e testes de autorização alinhados:
1. `brain_context_build` para montar o Context Pack da tarefa.
2. `brain_validate_implementation` antes de concluir alterações em regras de negócio.
3. `brain_create_handoff` / `brain_resume_handoff` para continuidade cross-IDE.

## MCP principal e MCP local (mesmo motor, modos distintos)

- Os dois MCPs executam o **mesmo código/motor**; o que muda é o **ambiente de execução** (`NOEMA_DEPLOYMENT_MODE=local|cloud`) e o transporte:
  - `noema` / **Noema principal** (`http://.../mcp` · Streamable HTTP): conecta no servidor compartilhado pelo time (nuvem/rede ou instância principal subindo com `npm run start:cloud`), usando a identidade, escopos e backend desse serviço.
  - `noema_local` / **Noema local** (`stdio` · `npm run start:local`): roda na máquina do agente, herda o `.env` local e acessa o checkout/arquivos locais. Pode operar **solo** na sua máquina/rede ou como **espaço offline (Edge)** sincronizado sob demanda via `brain sync pull` / `brain sync push` com qualquer servidor em nuvem.
- As descrições das ferramentas começam com o perfil da conexão. Leia esse prefixo antes de uma operação que grava dados.
- O rótulo `local` descreve onde o processo roda; se `DATABASE_URL` local apontar para a mesma base usada pelo serviço HTTP, os dados serão compartilhados diretamente em vez de isolados. Também não assuma sincronização automática entre bases distintas sem `pull`/`push`.
- Nesta configuração, os dois perfis retornaram o mesmo registro do projeto `noema` (`tenantId` e `createdAt`) e o mesmo item episódico. Isso confirma sobreposição dos dados observados, mas não identifica a configuração física do banco. Se o projeto não aparecer numa conexão, verifique `projectId`, tenant e escopos nela antes de criar outro registro.

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
