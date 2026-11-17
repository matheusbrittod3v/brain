# Connector Framework e Integrações de Negócio

O **Project Brain OS 2.0** não depende apenas de repositórios Git. Para entender a origem, a prioridade e a finalidade de cada funcionalidade, ele captura conhecimento de ferramentas de produto, design, operação, observabilidade e negócio por meio de um **Connector Framework** extensível (`packages/connector-framework`).

---

## 1. Arquitetura do Connector Framework

Nenhum conector externo escreve diretamente no núcleo ou altera regras aprovadas sem passar pelo pipeline padrão:

1. **Sincronização Incremental & OAuth:** Conectores SaaS usam Nango self-hosted quando configurado. `POST /v1/projects/:projectId/integrations/:provider/sync` enfileira a leitura da conexão Nango pelo worker; `NANGO_URL` e `NANGO_SECRET_KEY` ficam no servidor e não entram no job ou navegador. A conexão OAuth precisa ser criada no Nango antes do sync; o painel mostra estado, últimas execuções e avisos. Conectores de código (**GitHub, GitLab, Bitbucket**) usam o App/API do provedor para autenticação e operações remotas; operações Git locais podem chamar o executável `git` com argumentos separados. `simple-git` não é dependência adotada. `Octokit` é uma opção futura para chamadas REST do GitHub se paginação, limites de requisição ou quantidade de endpoints justificarem o SDK; não substitui o executável Git nem a validação de assinatura de webhooks.
2. **Mapeamento de Entidades (`integrations/*`):** Cada pasta em `integrations/` contém apenas o *mapper* declarativo que converte o payload externo para `KnowledgeItem` e `knowledge_relations`.
3. **Controle de Acesso & Proveniência:** Preserva `sourceUri`, `sourceVersion` e atribui o `accessPolicyId` e `trustLevel` adequados (ex.: mensagens do Slack ou tickets de CRM recebem classificação e sanitização de PII antes de entrar no índice vetorial).
4. **Deduplicação e Tratamento de Conflitos:** Cada item sincronizado usa chave canônica `(external_provider, external_id)` + `canonical_uri`. Quando um item do Jira e um arquivo no Git representam o mesmo requisito, eles **não são fundidos destrutivamente** — são vinculados no Knowledge Graph (`RELATED_TO` / `IMPLEMENTS`). Se divergirem em conteúdo, o Git vence nos domínios oficiais e o sistema registra um alerta no *Knowledge Health Monitor* para revisão humana.

---

## 2. Matriz de Ecossistemas e Integrações (`integrations/`)

| Ecossistema | Integrações Propostas | Conhecimento Capturado | Domínio(s) Destino |
| :--- | :--- | :--- | :--- |
| **Código** | GitHub, GitLab, Bitbucket | Commits, PRs, reviews, issues, releases e diffs | 03, 05, 07 |
| **Planejamento** | Jira, Linear, ClickUp, GitHub Projects | Épicos, backlog, tarefas, prioridades, sprints e bloqueios | 06 |
| **Documentação** | Notion, Confluence, Google Drive | Requisitos, políticas, atas, especificações e decisões | 01, 02, 03, 07 |
| **Design** | Figma | Telas, fluxos de usuário, componentes e especificações visuais | 02, 09 |
| **Banco de Dados** | PostgreSQL, Supabase, MySQL | Schemas, tabelas, chaves estrangeiras, views e migrações | 03, 05, 10 |
| **Observabilidade** | Sentry, Grafana, Datadog | Erros recorrentes, incidentes, SLOs, latência e métricas | 08, 10 |
| **Infraestrutura** | AWS, GCP, Azure | Recursos provisionados, deploys, ambientes e topologia | 08 |
| **Comercial / CRM** | HubSpot, Salesforce | Segmentos, processos comerciais, necessidades e regras de contrato | 02, 09 |
| **Comunicação** | Slack, Microsoft Teams; e-mail apenas para notificação/resposta configurada | Decisões e discussões em canais explicitamente autorizados; e-mail não é ingerido como fonte por padrão | 07, 12 |

## 3. HumanOps: Notificações, Perguntas e Aprovações por Canal

O Noema envia notificações por webhook genérico quando configurado e recebe respostas de Runner ou decisões de aprovação por callback autenticado. As ações interativas Slack usam botões Block Kit e callback assinado; Teams, Jira, ClickUp e e-mail ainda precisam de adaptadores próprios. A existência de um conector de ingestão não significa que ele já ofereça ações interativas.

### Fluxo de aprovação

1. Um agente ou processo cria uma proposta `pending` pelo fluxo normal (`brain_change_propose`/API). A proposta e sua versão ficam persistidas no Noema.
2. O roteador de notificações seleciona revisores autorizados e os canais configurados. A mensagem leva identificador da proposta, resumo mínimo, prazo e link autenticado ao registro completo. Dados confidenciais permanecem no Noema e só são exibidos após autorização.
3. O canal apresenta ações explícitas **Aprovar**, **Rejeitar** e **Solicitar alterações**. Resposta livre pode ser encaminhada como esclarecimento ao agente, mas nunca vale por si só como aprovação.
4. A resposta estruturada chega ao endpoint autenticado do Noema. O serviço valida assinatura do provedor quando aplicável, identidade humana mapeada para `actorId`, tenant/projeto, permissão atual, versão da proposta, prazo e chave de idempotência.
5. O Approval Engine realiza a transição de estado e grava auditoria com ator, canal, identificador do evento externo, ação, versão, data e justificativa. Eventos repetidos não criam uma segunda decisão.
6. O agente ou tarefa aguardando recebe o resultado pelo mecanismo de execução/consulta. O agente não recebe credenciais do canal nem pode aprovar a própria proposta.

**Semântica das respostas:** o Approval Engine persiste `pending`, `approved`, `rejected` e `changes_requested`. A rota de decisão aceita `approve`, `reject` e `request_changes`; o campo booleano `approved` continua aceito por compatibilidade. Toda decisão envia `proposalVersion`, comparada à versão atual do item; versões ausentes em callbacks ou desatualizadas são rejeitadas. Uma solicitação de mudanças mantém o item de conhecimento em `draft`, registra nota e revisor na solicitação de aprovação e remove a proposta da fila pendente. O autor pode enviar uma revisão pela rota `POST /v1/projects/:projectId/proposals/:proposalId/revise` ou pelo workspace Conhecimento; o mesmo pedido volta a `pending` com versão incrementada e histórico de decisão anterior preservado na auditoria. Outro autor, versão desatualizada ou proposta em outro estado são recusados. Timeout só pode gerar lembrete ou escalonamento; não aprova nem altera automaticamente a decisão.

Quando o manifesto do projeto declara Git como fonte autoritativa, uma aprovação por canal aprova a revisão/proposta, mas não substitui o merge do PR exigido para publicar a versão oficial no repositório. O painel e os canais não podem criar uma cópia oficial divergente do Git.

**Endpoints disponíveis e lacunas restantes:**

| Endpoint | Chamador | Payload mínimo e efeito |
| :--- | :--- | :--- |
| `POST /v1/projects/:projectId/change/propose` | Agente ou pessoa autenticada | Cria proposta `draft`; `relatedIds` opcional vincula itens existentes por relação `IMPACTS` após validar acesso. Essa relação permite mostrar impacto e cobertura das regras relacionadas na revisão. |
| `POST /v1/projects/:projectId/approvals/:proposalId/decision` | Pessoa autenticada pela API | Aceita `{ proposalVersion, decision: "approve"|"reject"|"request_changes", comment?, channel?, externalEventId? }`; também aceita `{ approved: boolean }` por compatibilidade, sempre com `proposalVersion`. `actorId` vem da autenticação. Quando enviado, `externalEventId` é persistido por tenant/canal; replay idêntico retorna a resposta original sem repetir decisão/auditoria, e conteúdo diferente retorna `409`. |
| `POST /v1/projects/:projectId/proposals/:proposalId/assign` | Revisor/admin autorizado | Recebe `{ provider, externalUserId }`; valida ator mapeado para tenant, projeto e política e permissão no domínio, atribui ou reatribui somente propostas pendentes e grava auditoria. Enquanto atribuída, somente esse ator pode decidir. |
| `GET/PUT/DELETE /v1/projects/:projectId/notification-preferences` | Pessoa autenticada | Lê, salva ou restaura preferências do próprio ator para canais, categorias e frequência. A API deriva `actorId` do token e o RLS também restringe a linha ao ator. |
| `POST /v1/integrations/slack/actions` | Slack Block Kit | Recebe `application/x-www-form-urlencoded` com `payload`, valida `x-slack-request-timestamp` e `x-slack-signature` (máximo de 5 minutos), converte os três botões de aprovação em eventos idempotentes e encaminha ao fluxo canônico. Configure a Request URL do app Slack para essa rota e `NOEMA_WEBHOOK_SECRET_SLACK` com o Signing Secret. |
| `POST /v1/integrations/:provider/events` | Adaptador ou provedor de canal | Aceita `approval.decision` com `proposalVersion`, `externalUserId`, `decision` (ou `approved` legado), projeto/proposta, comentário e `externalEventId` obrigatório. Exige bearer da API e HMAC válido. O Noema mapeia a identidade externa para ator, tenant, papéis, projetos e políticas via `NOEMA_EXTERNAL_ACTOR_MAP_JSON`. Eventos idênticos são deduplicados com registro persistente no PostgreSQL; chave reutilizada com outro conteúdo é conflito. |
| `POST /v1/projects/:projectId/runner/tasks/:taskId/questions` | Runner ou agente autorizado | Registra pergunta pendente vinculada à tarefa; só permite uma pergunta pendente por tarefa. `GET .../questions` retorna histórico e estado. |
| `POST /v1/projects/:projectId/runner/tasks/:taskId/questions/:questionId/notify` | Operador autenticado | Envia uma pergunta pendente para Slack, Teams, Jira, ClickUp ou e-mail, respeitando canal/categoria/frequência das preferências do ator. Digest usa somente webhook configurado no servidor e agrupa eventos do mesmo ator, canal, categoria e janela. |
| `POST /v1/projects/:projectId/runner/tasks/:taskId/responses` | Pessoa autenticada pela API | Exige `{ questionId, response, idempotencyKey }`, responde somente à pergunta pendente ligada à tarefa e re-enfileira o Runner. Repetição idêntica retorna sucesso sem repetir auditoria; resposta diferente ou chave reutilizada retorna `409`. A resposta é incorporada à instrução quando o worker reivindica a tarefa. |
| `POST /v1/integrations/:provider/events` com `eventType: runner.question.response` | Callback HMAC | Exige usuário externo mapeado, `projectId`, `taskId`, `questionId`, resposta e chave idempotente; valida escopo OPA e usa a mesma retomada e auditoria do endpoint direto. Reenvios idênticos são idempotentes. |

Os endpoints diretos, callbacks HMAC, comparação de versões, auditoria, atribuição, resultados de CI e preferências pessoais de notificação estão implementados. Preferências podem desativar canais/categorias ou agrupar avisos em digest diário/semanal. O digest usa webhook de canal configurado no servidor; preferências são por ator OIDC (ou `local-dev` no modo de chave compartilhada). Solicitações persistem `due_at`; pg-boss agenda lembrete e escalonamento, e o worker grava eventos deduplicados apenas quando a proposta segue pendente com o mesmo prazo. Eventos autorizados ficam disponíveis em `GET /v1/projects/:projectId/approval-reminders`; expiração não decide a proposta. Ações interativas Slack estão implementadas com botões Block Kit para aprovar, rejeitar ou solicitar alterações; o endpoint `/v1/integrations/slack/actions` valida a assinatura nativa `v0` e janela de 5 minutos, mapeia a identidade Slack e encaminha a decisão ao fluxo canônico. A URL de interação do app Slack deve apontar para esse endpoint e `NOEMA_WEBHOOK_SECRET_SLACK` deve conter o Signing Secret. Teams (Adaptive Cards), Jira (ADF), ClickUp e e-mail também possuem formatação de notificação e parsing interativo implementados em `integrations/saas/src/index.ts` e roteados via `POST /v1/integrations/:channel/actions`.

O mapa usa o identificador estável do usuário emitido pelo provedor, nunca o nome de exibição. Exemplo de configuração (os papéis, projetos e políticas devem refletir as permissões reais da pessoa):

```json
{
  "jira": {
    "jira-account-42": {
      "actorId": "person:42",
      "tenantId": "default-org",
      "roles": ["tech-lead"],
      "projectIds": ["noema"],
      "policyIds": ["internal-project"]
    }
  }
}
```

### Perguntas do agente

O agente pode enviar uma pergunta contextualizada ao revisor designado e aguardar resposta no mesmo canal. O texto recebido é uma entrada externa não confiável: deve ser associado ao usuário autenticado, tarefa, projeto e pergunta original; pode orientar o trabalho do agente dentro do escopo concedido, mas não altera políticas nem promove conhecimento aprovado. Se a resposta também pretende aprovar uma proposta, o revisor deve usar a ação explícita de aprovação.

### Configuração e operação

- Cada canal é habilitado por administrador do tenant, com escopos mínimos, mapeamento de identidades, projetos permitidos e política de retenção.
- O administrador define canal padrão, revisores de fallback, prazos e escalonamento. Sem canal ou revisor autorizado, a tarefa fica visível na Caixa de Entrada do Command Center.
- Notificações podem ser desativadas por usuário/categoria. Falhas de entrega ficam visíveis em **Integrações/Operação** e não mudam o estado da proposta.
- O conector de canal não é fonte de verdade para status, ACL, auditoria ou versão; esses dados pertencem ao Noema.

> **Nota de Escopo:** Os diretórios em `integrations/` representam conectores modulares planejados para o ecossistema completo da plataforma. Os detalhes de segurança e autoridade da decisão seguem [security-architecture.md](../03-security-and-governance/security-architecture.md) e as decisões normativas 86–87.

---

## 4. Estratégia para Repositórios Online no GitHub (Sem Clone Local)

### Estado da ingestão Git
O worker ingere arquivos de checkout local e de repositório GitHub remoto, calcula o hash do conteúdo no parser e faz upsert versionado. Reexecutar o mesmo conteúdo não cria nova versão do item; embeddings são substituídos e arestas usam conflito idempotente no PostgreSQL. O worker reprocessa esses dados derivados mesmo quando o item não mudou, para recuperar uma execução anterior que salvou o item e falhou ao indexar embeddings.

Para iniciar ingestão remota, envie `POST /v1/projects/:projectId/github/ingest` com `{ "owner": "org", "repo": "repo", "ref": "main" }` e bearer do projeto. A rota exige permissão OPA de escrita e `NOEMA_PG_BOSS=1`; o worker lê a árvore/arquivos pelo GitHub API, salva o SHA real do commit como versão da fonte e limita a seleção a 500 arquivos de até 1 MiB cada. Repositórios públicos não exigem token; para privados configure `GITHUB_TOKEN` ou `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID` e `GITHUB_APP_PRIVATE_KEY` no worker. A API detecta repositórios públicos e importa-os como referências externas `untrusted`, em rascunho, com IDs isolados pelo repositório e sem arestas que as promovam ao grafo interno. Árvores truncadas são canceladas para evitar ingestão parcial.

Webhooks `push` do GitHub enfileiram o commit quando `GITHUB_WEBHOOK_SECRET` valida o HMAC sobre o corpo bruto e `NOEMA_GITHUB_REPO_MAP_JSON` mapeia `owner/repo` para `tenantId`, `projectId` e `accessPolicyId`. O job usa o SHA imutável do commit; a API mantém o HEAD aceito por branch e ignora eventos fora de ordem. O worker serializa jobs por tenant/projeto/repositório/branch e mantém um checkpoint separado do último commit processado com sucesso. Quando o `before` do push coincide com o checkpoint, usa Compare API para buscar apenas arquivos alterados; bootstrap, divergência, diffs grandes e reprocessamento do commit atual usam snapshot completo. Exclusões e renomeações aposentam fontes removidas e apagam embeddings e relações derivadas. Erros por arquivo impedem avançar o checkpoint, para que a próxima tentativa possa recuperar por snapshot. Árvores truncadas são canceladas para evitar ingestão parcial. Repositórios sem mapeamento, outros tipos de evento e assinaturas inválidas são recusados. O job é auditado como ator de sistema.

Em ambientes com múltiplos microsserviços, times distribuídos ou bibliotecas de referência, nem todo repositório está clonado na máquina do desenvolvedor. O conector **GitHub (`integrations/github/`)** permite usar repositórios online diretamente no **Project Brain OS 2.0** em quatro frentes:

### 1. Indexação Remota Leve (Repos Próprios ou da Organização)
- **Autenticação:** Via **GitHub App / OAuth** (nuvem/times) ou **PAT / `gh` CLI** (modo Local-First).
- **Ingestão Sem Clone Pesado:** O worker utiliza `git clone --depth 1 --filter=blob:none` (*partial/shallow clone*) ou a **GitHub Trees/Contents API** para ler apenas arquivos relevantes (`.brain/`, código, OpenAPI, schemas, testes), calcular `content_hash` e indexar no PostgreSQL FTS + `pgvector` + Knowledge Graph. ParadeDB BM25 pode ser habilitado depois de evals; o diretório temporário é descartado em seguida.
- **Sync em Tempo Real:** Webhooks (`push`, `pull_request`, `issues`, `release`) mantêm o cérebro atualizado mesmo para microsserviços que o usuário nunca clonou localmente — essencial para **Federated Context Packs**, **CTO**, **QA** e **AppSec**.

### 2. Repositórios Externos de Referência (Open-Source, SDKs e Templates)
- Repositórios públicos do GitHub (ex.: documentação oficial de um framework, SDK usado pelo time ou projeto open-source de referência) são conectados em modo **somente leitura (`sourceOrigin: "external_reference"`, `sourceKind: "git"`, `trustLevel: "untrusted"`)**. O worker força status `draft`, namespace de IDs por repositório e não cria relações para regras internas a partir desses arquivos.
- O sistema indexa docs, exemplos e assinaturas de código na versão/tag exata usada pelo projeto, isolando-os das regras de negócio internas para que os agentes não alucinem APIs desatualizadas.

### 3. Pull Requests e Code Review Automáticos via API
- Como o **Git é a fonte da verdade** para conhecimento oficial, aprovações no *Command Center*, propostas via `brain_change_propose` ou sugestões do *Living Documentation* usam a **GitHub API** para criar commits e abrir Pull Requests diretamente no repositório online, sem depender de máquina local.
- O **Architecture Guardian** e o **Business Rule Guardian** atuam nativamente como **GitHub Checks / PR Comments** nos PRs abertos no GitHub.

### 4. Agent Handoff Remoto entre Máquinas e IDEs
- Quando um dev inicia uma tarefa em uma IDE (ex.: Antigravity) e deseja continuar em outra máquina ou ambiente cloud (ex.: Codex/Kiro/Codespaces), o `Agent Handoff` publica a branch efêmera (`handoff/<taskId>`) diretamente no remoto do GitHub (ou salva o patch no MinIO/S3), permitindo retomar o código e o contexto de qualquer lugar.

