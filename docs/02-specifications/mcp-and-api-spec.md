# Especificação de API, Ferramentas MCP, CLI e Protocolos

O **Project Brain OS 2.0** expõe operações via **API Fastify (`apps/api`)**, que hospeda REST, MCP remoto (`/mcp`) e rotas do Gateway (`/gateway`); **`apps/mcp-server`** fornece o transporte local `stdio`, iniciado pela CLI (`apps/cli`). Adaptadores de IDE geram configuração e instruções curtas, sem executar lógica de negócio. Os contratos canônicos ficam em `protocols/`.

---

## 0. Compatibilidade Multi-Harness, Plugin, MCP e CLI

Para funcionar em qualquer ferramenta ou plataforma de IA (Antigravity, Codex, Kiro, Cursor, Claude Code, VS Code, JetBrains, Continue, Cline, OpenAI/Anthropic/Gemini harnesses ou pipelines CI), o gateway suporta três modos de transporte e integração:

1. **MCP Local (`stdio`):** Executado localmente via CLI (`brain mcp serve`) para uso *Local-First* com latência mínima.
2. **MCP Remoto (`Streamable HTTP`):** Hospedado na rota `/mcp` de `apps/api`, autenticado por API Key no modo local/dev ou OIDC no Hub corporativo.
3. **CLI & Plugins (`brain <comando>`):** A CLI oferece equivalentes às operações MCP de contexto, busca, impacto, validação, handoff, proposta e delegação. Administração, conectores, auditoria, sync e export ficam na CLI/REST conforme a matriz abaixo.

> **Regra de Nomenclatura MCP:** Todas as ferramentas utilizam exclusivamente `snake_case` (`[a-z0-9_]`, ex.: `brain_context_build`). Evita-se pontos (`.`) nos nomes de tools para garantir 100% de compatibilidade com clientes MCP e harnesses que restringem caracteres especiais.

---

## 1. Catálogo Canônico de Ferramentas MCP (13 Tools Sem Sobreposição)

Para evitar que modelos de IA escolham ferramentas redundantes ou desperdicem tokens com dezenas de schemas parecidos, o servidor MCP expõe **exatamente 13 ferramentas canônicas** em `snake_case` (Streamable HTTP no Hub via `apps/api`; `stdio` local via `apps/mcp-server`). Operações de listagem usam paginação *cursor-based* (`limit`, `cursor`); leituras de item único, criações e ações não são paginadas. Todas as tools e endpoints usam erros padrão (`BRAIN_ERR_UNAUTHORIZED`, `BRAIN_ERR_NOT_FOUND`, `BRAIN_ERR_CONFLICT`, `BRAIN_ERR_POLICY_DENIED`, `BRAIN_ERR_RATE_LIMITED`).

### Matriz Oficial de Operações: MCP × CLI × REST
- **Contexto, Busca, Impacto, Validação, Handoff, Proposta e Delegação:** disponíveis em **MCP (13 tools) + CLI + REST**.
- **Administração, Conectores, Auditoria, Sync Edge (`pull`/`push`) e Export `.brainpack`:** disponíveis exclusivamente em **CLI + REST** (não poluem o contexto MCP dos agentes).

### Contratos de Entrada, Saída e Paginação das 13 Tools MCP
Todos os campos listados como inputs são propriedades de nível superior no objeto de argumentos da tool. `handoffId` e `taskId` em `brain_resume_handoff` são alternativas exclusivas (`oneOf`).
| Tool MCP | Inputs Obrigatórios (+ Opcionais) | Retorno Principal | Paginação |
| :--- | :--- | :--- | :--- |
| `brain_bootstrap_project` | `projectId`, `workspacePath?`, `branch?` | `projectId`, `workspacePath`, `branch`, `overviewItems[]` | Não |
| `brain_context_build` | `projectId`, `task`, `intent?`, `includeDomains?`, `tokenBudget?`, `explain?`, `sessionId?`, `taskId?` | `ContextPack` + `sessionId`, `hitRate { hits, itemsSent, rate }`; fontes entregues são persistidas | Não |
| `brain_search` | `projectId`, `query`, `domains?`, `atDate?`, `limit?`, `cursor?` (campos irmãos) | `items[]`, `nextCursor` | Sim |
| `brain_knowledge_get` | `projectId`, `id`, `version?`, `depth?`, `sessionId?` | `KnowledgeItem` da versão solicitada + `relations[]`; com sessão, registra evidência `read` | Não |
| `brain_get_active_rules` | `projectId`, `query?`, `serviceId?`, `tags?`, `limit?`, `cursor?` (campos irmãos) | `rules[]`, `adrs[]`, `nextCursor?` | Sim |
| `brain_find_related_code` | `projectId`, `targetId`, `limit?`, `cursor?` | `related[]` hidratado com metadados autorizados e listas `symbols[]`, `files[]`, `tests[]` classificadas por tipo/sourceUri; referências sem KnowledgeItem preservam apenas o hit do grafo; `nextCursor?` | Sim |
| `brain_analyze_change_impact` | `projectId`, `targetIds[]` (mínimo 1), `limit?` | `confirmedImpacts[]`, `hypotheses[]`, `directImpacts[]`, `transitiveImpacts[]`, `criticalRulesImpacted[]`, `crossServiceImpacts[]`, `riskLevel` | Não |
| `brain_validate_implementation` | `projectId`, `diffOrPaths[]` ou alias `paths[]` (ao menos um caminho; `limit?`) | `passed`, `checkedPaths[]`, `checkedRules`, `checkedImports`, `violations[]` (resultado limitado, sem cursor). Caminhos relativos são confinados ao workspace configurado. | Não |
| `brain_create_handoff` | `projectId`, `taskId`, `nextSteps[]`, `plan?`, `branch?` | Objeto completo do handoff persistido | Não |
| `brain_resume_handoff` | `projectId`, `handoffId?` ou `taskId?` (exatamente um obrigatório), `currentBranch?`, `currentCommitSha?` | Estado do handoff e `warnings[]` para divergência de branch/commit, working tree dirty e lease ativo | Não |
| `brain_record_learning` | `projectId`, `summary`, `usedItemIds[]?`, `sessionId?`, `taskId?`, `editedPaths[]?`, `missingPaths[]?` | `{ recorded, hitRateUpdated, hitRate, warnings[] }`; citações exigem itens entregues na sessão; edição exige lease ativo do ator e caminho exato de fonte entregue | Não |
| `brain_change_propose` | `projectId`, `title`, `content`, `targetType?` | `{ proposalId, status: 'draft', projectId, title, sourceUri }`; no runtime SQL, persiste o item draft/versionado e a solicitação de aprovação no PostgreSQL antes do sucesso | Não |
| `brain_delegate_task` | `projectId`, `instruction`, `cron?`, `priority?` | Sem cron, tarefa enfileirada (`taskId`, `status`); com cron e PostgreSQL/pg-boss configurados, `{ scheduleId, status: 'scheduled', cron }` em UTC | Não |

### Autenticação *On-Behalf-Of* por Cliente MCP
- **Clientes com OIDC/OAuth (Antigravity, VS Code, Web, CLI `brain mcp connect`):** obtêm token do usuário humano e incluem claim `agent_id` validado pelo Gateway/Keycloak.
- **Clientes sem OBO nativo (ex.: `stdio` em agentes headless):** usam **OIDC Client Credentials** (*service account*) com escopo restrito ao `projectId` + `userId` configurado no keyring local, nunca com acesso irrestrito à organização.

| # | Ferramenta MCP | Tipo | Papel Único e Objetivo |
| :--- | :--- | :--- | :--- |
| **01** | `brain_bootstrap_project` | Leitura | Identifica projeto/branch via `.project-brain.json` e retorna visão geral, stack, estado atual e alertas |
| **02** | `brain_context_build` | Leitura | Monta um `Context Pack` completo e otimizado em tokens (regras, arquitetura, código, tarefas, decisões e fontes) para uma tarefa |
| **03** | `brain_search` | Leitura | Busca híbrida direta (PostgreSQL FTS + busca vetorial + filtros de domínio/status/data temporal; ParadeDB BM25 opcional) |
| **04** | `brain_knowledge_get` | Leitura | Obtém um item específico por `id` (e versão/commit opcional) + suas relações no Knowledge Graph |
| **05** | `brain_get_active_rules` | Leitura | Lista regras de negócio (`BusinessRule`), padrões de engenharia e ADRs aplicáveis a um serviço, módulo ou tag |
| **06** | `brain_find_related_code` | Leitura | Busca símbolos AST/SCIP, dependências e testes ligados a uma regra, requisito ou arquivo |
| **07** | `brain_analyze_change_impact` | Leitura | Calcula impactos técnicos e comerciais confirmados vs. hipóteses antes de editar código ou regras |
| **08** | `brain_validate_implementation` | Leitura | Valida um diff/PR/implementação contra regras de negócio, arquitetura (Guardians) e critérios de aceite |
| **09** | `brain_create_handoff` | Escrita | Salva checkpoint validado para outro agente/IDE (plano, branch, commit/patch, arquivos, testes, próximos passos) |
| **10** | `brain_resume_handoff` | Leitura | Retoma tarefa iniciada em outra IDE/sessão, verificando divergências de branch/commit |
| **11** | `brain_record_learning` | Escrita | Registra descoberta episódica ou feedback de utilidade do contexto (`Context Hit Rate`) |
| **12** | `brain_change_propose` | Escrita | Submete proposta formal (abre PR/rascunho para aprovação humana) para criar ou alterar regra, ADR ou doc |
| **13** | `brain_delegate_task` | Escrita | Enfileira uma tarefa rotineira ou agendada em background para o **Brain Runner** (`apps/agent-runner`) sem travar a IDE |

---

## 2. Protocolos Formais (`protocols/`)

Para garantir interoperabilidade entre `apps/api`, `apps/mcp-server` (stdio), `apps/cli`, o módulo Brain Runner e adaptadores de IDE, seis contratos versionados vivem em `protocols/`:

| Protocolo | Diretório | Conteúdo do Contrato |
| :--- | :--- | :--- |
| **Context Pack** | `protocols/context-pack/` | Estrutura padrão de retorno de contexto (regras, arquitetura, código, tarefas, `warnings`, `conflicts`, `sources` e `tokenUsage`). |
| **Agent Handoff** | `protocols/agent-handoff/` | Checkpoint de continuidade: `handoffId`, `fromAgent`, `projectId`, `taskId`, `repoUrl`, `branch`, `baseCommitSha`, `modifiedFiles`, `testsExecuted`, `decisions`, `nextSteps`. |
| **Knowledge Events** | `protocols/knowledge-events/` | Eventos assíncronos (`knowledge.updated`, `rule.superseded`, `conflict.detected`, `handoff.created`) para invalidar caches e notificar IDEs. |
| **Project Manifest** | `protocols/project-manifest/` | Arquivo declarativo na raiz do repositório (`.project-brain.json`) ligando o workspace local ao `projectId`, `tenantId`, `knowledgeRoot` e adaptadores ativos. |
| **Runner Tasks** | `protocols/runner-tasks/` | Jobs sob demanda e agendados; cada disparo cron materializa uma linha idempotente em `runner_tasks` para o executor (`taskId`, `maxSteps`, `timeout`, `draftOnly`, `escalateOnFailure`). |
| **Edge Sync** | `protocols/edge-sync/` | Formato de deltas incrementais (`pull`), revogação de políticas (*Policy Revocation*) e pacotes de *Local Staging* (`push`). |

---

## 4. Exemplo de Contrato: `brain_context_build`

### Requisição
```json
{
  "projectId": "subscription-platform",
  "task": "Implementar cancelamento de assinatura",
  "intent": "implement",
  "includeDomains": [2, 3, 4, 5, 6, 7],
  "tokenBudget": 6000,
  "explain": false
}
```

### Resposta (Context Pack)
```json
{
  "project": "subscription-platform",
  "task": "Implementar cancelamento de assinatura",
  "context": {
    "businessRules": [
      {
        "id": "BR-SUB-014",
        "title": "Cancelamento de assinatura",
        "version": "3",
        "status": "approved",
        "summary": "Cliente autorizado pode cancelar; validar chargeback e fidelidade.",
        "sourceUri": ".brain/01-business/business-rules/BR-SUB-014.yaml",
        "trustLevel": "verified",
        "sourceOrigin": "internal",
        "chunkIndex": 0
      }
    ],
    "architecture": [
      {
        "id": "ADR-021",
        "title": "Máquina de estados de assinatura assíncrona",
        "status": "approved",
        "sourceUri": ".brain/03-architecture/decisions/ADR-021.md",
        "trustLevel": "verified",
        "sourceOrigin": "internal",
        "chunkIndex": 0
      }
    ],
    "services": [
      {
        "id": "subscription-service",
        "path": "src/modules/subscription/subscription.service.ts",
        "commit": "a1b2c3d"
      }
    ],
    "tests": [
      "tests/subscription/subscription-cancel.spec.ts"
    ],
    "tasks": [
      {
        "id": "TASK-482",
        "title": "Implementar endpoint POST /subscriptions/:id/cancel",
        "status": "in_progress"
      }
    ]
  },
  "warnings": [
    "Validar exceções contratuais descritas em BR-SUB-014 antes de efetivar reembolso.",
    "Nenhuma regra de retenção automática encontrada para plano Enterprise (lacuna)."
  ],
  "conflicts": [],
  "sources": [
    {
      "id": "BR-SUB-014",
      "version": "3",
      "status": "approved",
      "sourceUri": ".brain/01-business/business-rules/BR-SUB-014.yaml",
      "trustLevel": "verified",
      "sourceOrigin": "internal",
      "chunkIndex": 0
    },
    {
      "id": "ADR-021",
      "version": "1",
      "status": "approved",
      "sourceUri": ".brain/03-architecture/decisions/ADR-021.md",
      "trustLevel": "verified",
      "sourceOrigin": "internal",
      "chunkIndex": 0
    }
  ]
}
```

---

## 5. Endpoints REST Principais (`apps/api`)

No Hub, endpoints chamados por usuários exigem token **OIDC (Bearer JWT)**; no modo Local-First, aceitam API Key local. Webhooks GitHub exigem HMAC e mapeamento de repositório para tenant/projeto/política; payloads sem assinatura ou escopo confiável são recusados. Callbacks HumanOps genéricos exigem bearer, HMAC e identidade externa mapeada por tenant/projeto/política; a rota nativa Slack valida a assinatura e timestamp Slack e encaminha internamente ao mesmo fluxo canônico. Decisões de aprovação deduplicam pelo identificador do evento no PostgreSQL; respostas do Runner deduplicam pela chave idempotente persistida na pergunta. Rotas com stores PostgreSQL usam contexto RLS; detalhes de disponibilidade e lacunas estão marcados abaixo.

- `GET /v1/projects/:projectId/overview` — Visão geral e saúde do projeto
- `POST /v1/projects/:projectId/context` — Equivalente HTTP ao `brain_context_build`
- `GET /v1/projects/:projectId/knowledge/:itemId?sessionId=...` registra evidência `read` somente se o item foi entregue naquela sessão. `POST /search/feedback` aceita `sessionId`/`itemIds` para evidência `citation`; edição exige `taskId` e lease ativo do ator. O Noema compara SHA-256 dos arquivos locais elegíveis no workspace entre o primeiro envio do Context Pack e o feedback; `editedPaths` opcional pode restringir os caminhos detectados, mas nunca cria evidência por si só. URIs remotas, arquivos indisponíveis no envio e caminhos fora do workspace não têm detecção automática. `hitRate` usa itens distintos do Context Pack como denominador; buscas diretas não entram. Caminhos sem mudança, baseline ou correspondência com fonte/tarefa retornam em `warnings[]` e não geram hits.
- `POST /v1/projects/:projectId/search` — Busca híbrida paginada
- `GET /v1/projects/:projectId/knowledge/:itemId` — Detalhes e histórico de versões
- `GET /v1/projects/:projectId/proposals/:proposalId/history` — Eventos de criação, decisão, revisão e callback associados à proposta, limitados ao escopo autorizado de projeto/política.
- `GET /v1/projects/:projectId/graph/:itemId/related` — Subgrafo de relações
- `POST /v1/projects/:projectId/handoffs` e `GET /v1/projects/:projectId/handoffs/latest` — Criação e retomada de handoffs
- `POST /v1/projects/:projectId/change/impact` — Análise de impacto técnico e de negócio; retorna relações confirmadas/hipóteses, impactos diretos/transitivos, blast radius cross-service autorizado, regras críticas afetadas e `riskLevel` calculado.
- `POST /v1/projects/:projectId/change/propose` — Submissão de proposta sujeita a aprovação; `relatedIds` opcional associa alvos existentes por arestas `IMPACTS`, validadas por OPA/RLS, para recuperar evidências de impacto e cobertura QA na revisão
- `POST /v1/projects/:projectId/runner/tasks` e `GET /v1/projects/:projectId/runner/tasks/:taskId` — Delegação e status de jobs no *Brain Runner*
- `GET /v1/projects/:projectId/runner/schedules` e `DELETE /v1/projects/:projectId/runner/schedules/:scheduleId` — Lista e cancela cron jobs do projeto; valida tenant/projeto e mantém tarefas já materializadas.
- `POST /v1/projects/:projectId/approvals/:proposalId/decision` — Decisão autenticada (`approve`, `reject`, `request_changes`) vinculada a `proposalVersion`; a fila persiste estado e bloqueia decisões repetidas. `externalEventId` opcional torna a chamada idempotente por canal: replay idêntico devolve a resposta armazenada e chave reutilizada com conteúdo diferente retorna `409`.
- `POST /v1/projects/:projectId/proposals/:proposalId/revise` — Após `request_changes`, o autor pode enviar conteúdo revisado com `baseVersion`; o Noema incrementa a versão e reabre a mesma proposta na fila. Outro autor, status diferente ou versão desatualizada é recusado.
- `POST /v1/projects/:projectId/proposals/:proposalId/assign` — Define ou reatribui o revisor de uma proposta pendente usando `{ provider, externalUserId }`. O Noema exige mapeamento com tenant/projeto/política compatíveis e permissão de aprovação para o domínio. Enquanto houver atribuição, somente o responsável pode decidir; reatribuir exige permissão de aprovação. A fila retorna `assignedTo` e a alteração entra no histórico auditado.
- `GET/PUT/DELETE /v1/projects/:projectId/notification-preferences` — Lê, salva e restaura preferências pessoais de canal, categoria e frequência (`immediate`, `daily`, `weekly`). O ator é extraído da autenticação e protegido por RLS; digest depende do webhook do canal configurado no servidor.
- `POST /v1/integrations/slack/actions` — Ações interativas Block Kit do Slack. Verifica HMAC nativo `v0` sobre o corpo bruto e timestamp dentro de 5 minutos, extrai projeto/proposta/versão do valor do botão e encaminha aprovação, rejeição ou solicitação de alterações ao endpoint canônico com identidade externa Slack mapeada. Configure `NOEMA_WEBHOOK_SECRET_SLACK` e a Request URL do app Slack.
- `POST /v1/projects/:projectId/github/ingest` — Enfileira ingestão remota GitHub (`owner`, `repo`, `ref`) após autenticação do projeto e autorização OPA de escrita. Exige pg-boss; o worker usa PAT ou GitHub App opcional e registra SHA real do commit.
- `GET /v1/projects/:projectId/github/jobs?limit=20` — Lista até 50 ingestões remotas recentes do projeto, filtradas por tenant e projeto; retorna fila, tentativas, horários e resumo de itens/chunks/avisos quando concluído. Exige permissão de leitura e PostgreSQL/pg-boss ativos.
- `GET /v1/projects/:projectId/integrations/status` — Mostra apenas estados seguros de configuração (sem valores de segredo), escopos GitHub mapeados, HEADs de `main` persistidos, filas disponíveis, canais de notificação e últimas sincronizações GitHub/Nango.
- `GET /v1/projects/:projectId/scaffold/recommendations?domain=...&stack=...` — Retorna até cinco ADRs do projeto que estejam `approved`, internas, verificadas e não inferidas, ordenadas por correspondência com domínio/stack. Se não houver precedente confirmado, retorna lista vazia e informa que nenhum padrão foi inferido.
- `GET /v1/projects/:projectId/access/profile` — Retorna ao próprio ator seus papéis e escopos efetivos OIDC/API Key para o projeto autorizado. Não administra membros ou concede acesso; essas mudanças ainda pertencem ao provedor OIDC.
- `GET /v1/projects/:projectId/operations/overview` — Visão operacional autenticada com saúde do projeto, cobertura QA, contagens de jobs por fila/estado nas últimas 24h e até 10 falhas recentes. Requer leitura OPA; detalhes pg-boss são consultados apenas quando configurado. Tokens indexados são estimativas por caracteres/4 e ficam separados do uso reportado pelo modelo; a rota agrega uso Ollama persistido em tarefas nos últimos 30 dias quando disponível.
- `GET /v1/projects/:projectId/finops` — Retorna contagem de itens, estimativa local de tokens, uso de modelo persistido e cobrança do provedor quando informada pelo executor. Para Ollama local, tokens e duração vêm da resposta da API e custo de API é USD 0; infraestrutura, energia e economia SaaS não são medidos/inferidos. Sem execução instrumentada, `actualProviderCostUsd` fica `null`.
- `POST /v1/projects/:projectId/integrations/:provider/sync` — Enfileira sincronização SaaS por `{ connectionId, model? }` depois de autorização OPA de escrita. Exige Nango e pg-boss configurados; credenciais permanecem no servidor/worker.
- `POST /v1/ingestion/webhooks/github` — Aceita somente evento `push`, valida HMAC SHA-256 sobre o corpo bruto com `GITHUB_WEBHOOK_SECRET`, resolve tenant/projeto/política por `NOEMA_GITHUB_REPO_MAP_JSON`, enfileira o SHA imutável e audita o job. Repositório sem mapeamento retorna `403`; configuração incompleta/inválida falha fechado.
- `POST /v1/integrations/:provider/events` — Callback `approval.decision`, com versão explícita, `externalUserId`, `externalEventId` obrigatório, deduplicação persistente, HMAC obrigatório e autenticação bearer. O mapeamento do ator inclui tenant, papéis, projetos e políticas via `NOEMA_EXTERNAL_ACTOR_MAP_JSON`.
- `POST /v1/projects/:projectId/runner/tasks/:taskId/questions` e `GET .../questions` — Cria e consulta perguntas vinculadas à tarefa; apenas uma pergunta pode ficar pendente por tarefa.
- `POST /v1/projects/:projectId/runner/tasks/:taskId/questions/:questionId/notify` — Envia uma pergunta pendente ao canal configurado e aponta para o workspace de agentes no painel.
- `POST /v1/projects/:projectId/runner/tasks/:taskId/responses` — Responde uma pergunta com `questionId` e `idempotencyKey`; resposta idêntica repetida é deduplicada, conflito de conteúdo retorna `409`, e a tarefa volta à fila para o Runner retomar com a resposta anexada à instrução.
- `POST /v1/integrations/:provider/events` com `eventType: runner.question.response` — Recebe resposta de canal com HMAC e usuário externo mapeado; repetições idênticas retornam sucesso sem repetir auditoria.
- `POST /v1/ingestion/webhooks/github` com evento `push` — Push assinado em `refs/heads/main` persiste HEAD por tenant/projeto/repositório e enfileira ingestão do commit; refs de outras branches não mudam o HEAD. Comparação com o `before` do evento impede que entrega atrasada faça o HEAD regredir. Mapeamento repo→tenant/projeto/política é obrigatório.
- `POST /v1/integrations/:provider/events` com `eventType: test.results` — Recebe de CI `projectId`, `externalUserId` mapeado com papel `ci-bot`, `runId`, `commitSha`, `repository` e resultados (`testItemId`, `status`, `durationMs`). Exige bearer e HMAC. `repository` pode ser omitido somente quando há um único repositório GitHub configurado para o projeto. Status aceitos: `passed`, `failed`, `skipped`; SHA tem 40–64 dígitos hexadecimais. Reenvio idêntico é idempotente; reutilizar execução/arquivo com conteúdo divergente retorna conflito. `GET /v1/projects/:projectId/enterprise/views` inclui a execução mais recente no HEAD atual por arquivo ligado via `VERIFIED_BY`; apenas teste existente e execução `passed` no HEAD persistido contam como cobertura. Projetos sem GitHub configurado continuam exigindo execução aprovada compatível com o SHA do snapshot indexado.
- `POST /v1/sync/pull` e `POST /v1/sync/push` — Sincronização incremental *Local Edge ↔ Enterprise Hub* (filtrada por OPA e *Ingestion Gate*)
- `POST /v1/privacy/erase` — Apaga registros do titular no projeto por `owner_id`/tag, versões, embeddings e relações; cria tombstones Edge; e apaga memórias, handoffs e tarefas com `actor_id` persistido, incluindo perguntas e leases das tarefas removidas. Exige PostgreSQL ativo e `DATABASE_SYSTEM_URL` com role `brain_system`. Retorna `complete: false`: MinIO/backups, registros operacionais legados sem `actor_id`, crypto-shredding e anonimização histórica da auditoria ainda não são cobertos.
- `POST /v1/ingestion/webhooks/:provider` — Webhooks externos (assinatura HMAC)
- `GET /v1/audit-logs?projectId=...&limit=100` — Trilha de auditoria restrita a admin/AppSec/Tech Lead; filtro de projeto verifica escopo e OPA antes de consultar. `limit` é limitado a 100.

---

## 6. Regras de Segurança nas Operações

1. **Leitura:** valida `tenantId`, `projectId` e `accessPolicyId` do ator antes da consulta.
2. **Escrita (`remember`, `consolidate`, `create_handoff`, `change.propose`):** exige identidade autenticada e grava evento obrigatório em `audit_logs`.
3. **Promoção de Conhecimento Oficial:** nenhuma ferramenta MCP altera diretamente o status de uma regra ou decisão para `approved`. A aprovação é uma ação humana autenticada feita no Command Center ou pela API; callback por canal valida HMAC, identidade mapeada e idempotência. O Approval Engine valida autorização, registra a decisão, permite ao autor reenviar uma revisão com versão nova após `request_changes` e bloqueia decisões repetidas na mesma versão. Se Git é a fonte autoritativa, aprovação no painel/canal não substitui o merge do PR. O catálogo MCP continua limitado às 13 tools canônicas.
