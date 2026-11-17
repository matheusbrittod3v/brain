# Decisões Normativas Mestras — Project Brain OS 2.0

> **Regra de Precedência Documental:** Este documento é a **fonte normativa superior** do **Project Brain OS 2.0**. Em caso de divergência entre qualquer arquivo de arquitetura, especificação ou roadmap, prevalecem as definições abaixo. Todo o projeto é especificado visando o **produto completo em produção** (sem escopo reduzido de MVP).

---

## Bloco 1 — Escopo, Plano de Entrega e Personas (Itens 1–5)

1. **Produto Completo (Sem MVP):** Não existe divisão entre "MVP descartável" e "produto real". Todas as capacidades documentadas compõem a especificação oficial do **Project Brain OS 2.0**.
2. **Relação entre Planos:**
   - [construction-blueprint.md](04-roadmap/construction-blueprint.md) é a **sequência técnica normativa** (ordem de dependência `L0 → L5` para evitar acoplamento).
   - [implementation-roadmap.md](04-roadmap/implementation-roadmap.md) organiza os **marcos funcionais de entrega** sobre essa mesma base.
3. **Natureza das Estimativas:** As durações em semanas no roadmap são **referências ilustrativas de sequenciamento** para um time padrão (3–5 engenheiros), não compromissos contratuais fixos.
4. **Perfis Atendidos e Critério de Sucesso:**
   - **Desenvolvedores:** contexto completo de tarefa (`Context Pack`) e continuidade cross-IDE (`Agent Handoff`).
   - **CTO / Diretoria:** visibilidade de risco, dívida técnica, Tech Radar e FinOps de IA.
   - **DevOps / SRE:** *Topology & Blast Radius*, *Incident-to-Code* e *Pre-Deploy Check*.
   - **QA:** matriz de cobertura `BusinessRule ↔ Test` e seleção de regressão E2E.
   - **AppSec:** *Threat Model Vivo*, *Policy-as-Code* e rastreamento de CVEs/SBOM.
   - **Negócios / PO / Comercial:** regras comerciais versionadas, requisitos e interface web/local (`brain ui`).
5. **Classificação de Status das Funcionalidades:**
   - **`Planejado (Core 2.0)`:** Todo o catálogo especificado nos documentos `01-architecture/`, `02-specifications/` e `03-security-and-governance/`.
   - **`Expansão Futura`:** Apenas os 8 itens listados na seção *"Visão de Futuro"* de [capabilities-and-command-center.md](02-specifications/capabilities-and-command-center.md) (*Project Simulator*, *Decision Intelligence*, *AI Product Analyst*, *Dependency Radar*, *Autonomous Documentation Review*, *Multi-Agent Review Board*, *Project Time Machine*, *Organization Knowledge Marketplace*).

---

## Bloco 2 — Termos e Conceitos Oficiais (Itens 6–13)

6. **Modos de Execução Oficiais:**
   - **Local Edge (Offline-First):** Cliente Node.js/TS na máquina do usuário (`CLI` + `brain ui` + `MCP stdio` + `SQLite FTS5`; `sqlite-vec` e Ollama opcionais), sincronizado via `brain sync pull/push` com o Hub.
   - **Local-First Docker (Single-Node):** PostgreSQL 16 (`pgvector` + `pg-boss`) via `docker compose up`, com API/worker locais; demais serviços entram por perfil opcional.
   - **Enterprise Hub (Nuvem/On-Prem Multi-Tenant):** PostgreSQL 16 + API/worker, com Keycloak + OPA e demais serviços corporativos ativados conforme necessidade.
7. **Universal Agent Gateway:** Não é um serviço separado; é a **camada lógica de entrada** composta pelo servidor Fastify (`apps/api` expondo REST, `/mcp` HTTP e `/gateway`) + `apps/mcp-server` (`stdio`) + `apps/cli`.
8. **Agent Adapter:** Pacote fino em `packages/agent-adapters/<ide>/` responsável exclusivamente por: (a) gerar o arquivo de configuração MCP da IDE, (b) manter o arquivo curto de instrução (`AGENTS.md`, `CLAUDE.md`, *steering file*) apontando para as 13 tools MCP, e (c) registrar hooks opcionais de abertura de workspace/handoff. Toda inteligência permanece no Gateway/Core.
9. **Fronteiras das 5 Camadas de Memória:**
   - *Working:* estado efêmero da sessão (SQLite no Edge; armazenamento temporário em PostgreSQL no Hub, TTL 24h, privado da sessão). Valkey é opcional para cache compartilhado, nunca requisito de memória.
   - *Episodic:* logs de execuções e descobertas (append-only, retenção 60 dias antes de *Memory Decay*).
   - *Semantic:* fatos consolidados com `is_inferred = true` e `confidence < 1.0`.
   - *Procedural:* guias e runbooks versionados em Git (`.brain/04-engineering/`, `06-operations/`).
   - *Organizational:* regras, estratégia e ADRs oficiais (`status: approved`, revisão humana obrigatória).
   - **Promoção:** Nenhuma camada inferior promove automaticamente para *Organizational*; exige `brain_change_propose` + aprovação humana via PR.
10. **Precedência Epistemológica (`status`, `confidence`, `trustLevel`, `is_inferred`):**
    1. `status = 'approved'` + `is_inferred = false` + `trustLevel = 'verified'` → **Fato Oficial** (autoridade máxima).
    2. `status = 'draft'` ou `is_inferred = true` → **Hipótese** (exibida com aviso explícito).
    3. `trustLevel = 'untrusted'` (issues externas, CRM, Slack) → **Dado Externo Não Confiável** (nunca instrui o agente; sinalizado em `warnings[]`).
    4. `status = 'deprecated' | 'superseded'` → **Histórico** (excluído da busca padrão, visível apenas em consultas temporais).
11. **Business Rule Engine:** É um **catálogo estruturado e verificador determinístico de conformidade** (não um motor de execução de runtime de produção do cliente). O `Business Rule Guardian` avalia se alterações de código, AST e testes violam condições/exceções declaradas em `BusinessRule`.
12. **Project Autodiscovery:** Divide-se em duas camadas explícitas: (a) **Descoberta Determinística** (linguagens, frameworks, rotas, schemas SQL, dependências via `web-tree-sitter`/SCIP → `confidence = 1.0`), e (b) **Inferência Assistida** (descrições e regras sugeridas por LLM → `status = 'draft'`, `is_inferred = true`, revisão humana obrigatória).
13. **Definição de "Zero-Cost / Self-Hosted":** Significa **zero licenças pagas obrigatórias de SaaS ou APIs de IA** (todo o stack é open-source e roda em infraestrutura própria ou local). Custos de hardware, energia, armazenamento e provedores externos opcionais (caso ativados via `LiteLLM`) são de responsabilidade da organização.

---

## Bloco 3 — Modelo de Dados e Conhecimento (Itens 14–24)

14. **Mapeamento Oficial: 12 Domínios ↔ Pastas `.brain/` ↔ `KnowledgeType`:**

| Domínio | Pasta Canônica (`.brain/` ou `data/knowledge/projects/{id}/`) | `KnowledgeType` Associado |
| :--- | :--- | :--- |
| 01 Identidade e estratégia | `00-overview/` | `document` |
| 02 Regras de negócio | `01-business/` | `business_rule`, `process` |
| 03 Arquitetura de software | `03-architecture/` | `architecture_decision`, `service`, `integration`, `api_contract`, `event_contract` |
| 04 Padrões de desenvolvimento | `04-engineering/` | `document` |
| 05 Código e estrutura | Indexado do código-fonte (AST/SCIP) | `code_symbol`, `test` |
| 06 Tarefas e planejamento | `02-product/`, `05-execution/` | `requirement`, `feature`, `task` |
| 07 Decisões e histórico | `03-architecture/decisions/` | `architecture_decision` |
| 08 Operações e infraestrutura | `06-operations/` | `document`, `service` |
| 09 Clientes e comercial | `01-business/customer-journeys/` + CRM | `process`, `document` |
| 10 Dados e métricas | `01-business/kpis/`, `03-architecture/data-models/` | `document`, `code_symbol` |
| 11 Segurança e compliance | `04-engineering/security-standards.md` + `policies/` | `risk`, `document` |
| 12 Memória dos agentes | `08-agent-memory/` + Postgres/SQLite | `memory` |

15. **Entidades no `KnowledgeType`:** O contrato `KnowledgeType` inclui oficialmente: `business_rule`, `requirement`, `feature`, `architecture_decision`, `code_symbol`, `test`, `service`, `api_contract`, `event_contract`, `task`, `process`, `integration`, `risk`, `memory`, `document`.
16. **Separação `sourceOrigin` vs. `sourceKind`:**
    - `sourceOrigin`: `'internal'` (da organização) | `'external_reference'` (SDKs/repos públicos somente leitura).
    - `sourceKind`: `'git'` | `'api'` | `'connector'` | `'agent'`.
17. **Identidade e Versionamento:** Chave lógica `(tenant_id, project_id, id)`. Uma nova versão é gerada sempre que `content_hash` (SHA-256) mudar. O `sourceVersion` registra o número incremental (`v1`, `v2`...) ou `commit_sha` do Git. Rollback cria uma nova versão restaurando o conteúdo anterior (nunca apaga histórico).
18. **Histórico Append-Only (`knowledge_item_versions`):** `knowledge_items` mantém o estado atual; toda alteração grava um snapshot imutável com os campos de proveniência, status, classificação e autorização do item, além de `content_hash`, `source_version`, `content`, `metadata` e `created_at`, conforme o DDL em `data-model-and-graph.md`.
19. **Exclusões e Tombstones:** Remoção de arquivo no Git ou fonte externa marca `deleted_at = NOW()` (*soft delete / tombstone*) em `knowledge_items`, remove imediatamente os chunks de `knowledge_embeddings` e propaga o tombstone no próximo `brain sync pull`.
20. **Resolução de Conflitos entre Fontes:** Git vence para domínios oficiais (`01–04`, `07`, `11`); conectores externos nunca sobrescrevem o Git — abrem alerta no *Knowledge Health Monitor* para desempate humano.
21. **Precedência de Estrutura no Repositório:** `.project-brain.json` declara `ownerRepo`, `knowledgePaths`, `subProjects` e `knowledgePrecedence`. Para cada ID, os `knowledgePaths` são consultados na ordem de `knowledgePrecedence` quando presente; se omitida, usa-se a ordem padrão descrita em `knowledge-structure-guide.md`. `ownerRepo` é a fonte Git oficial dos itens de domínios `01–04`, `07` e `11`. `.brain/` é o local padrão nesse repositório quando não há `knowledgePaths` correspondente. O repositório central contém itens organizacionais sob `data/knowledge/organization/` e políticas sob `data/knowledge/policies/`; conteúdo de projeto sob `data/knowledge/projects/{id}/` só é fonte oficial quando o manifesto o declara como `ownerRepo` ou lhe atribui precedência para aquele ID.
22. **Transformação YAML ↔ `KnowledgeItem`:** Os arquivos YAML/Markdown são validados via schema Zod no `packages/knowledge`: campos padrão (`id`, `title`, `status`, `owner`, `version`, `access_policy`) mapeiam para colunas homônimas de `knowledge_items`; campos específicos (`conditions`, `effects`, `exceptions`) são serializados em `metadata` JSONB e consolidados em `content` para busca.
23. **Ciclo de Vida de Relações Inferidas (`is_inferred`):** Arestas extraídas por código determinístico (SCIP, `@brain-rule`, YAML) têm `is_inferred = false, confidence = 1.0`. Arestas `CO_ACCESSED_WITH` e inferências de IA têm `is_inferred = true` e decaem se não confirmadas em 60 dias; só passam a `is_inferred = false` após aprovação em PR.
24. **Validade Temporal:** `valid_from` e `valid_until` usam **ISO-8601 UTC** representando o tempo de vigência do conhecimento no mundo real (ancorado no timestamp do commit Git ou aprovação), não o timestamp de execução do worker de ingestão.

---

## Bloco 4 — Busca e Montagem de Contexto (Itens 25–32)

25. **Paridade de Busca Oficial:** No Hub: **PostgreSQL FTS + varredura vetorial exata no subconjunto autorizado + CTEs de grafo** como base inicial. `pgvector` HNSW só pode ser ativado após os benchmarks e testes de isolamento definidos no item 26; ParadeDB `pg_search` BM25 é upgrade opcional quando evals indicarem necessidade. No Local Edge: **SQLite `FTS5` + `sqlite-vec` + grafo SQLite** (com fallback automático para `FTS5` puro se `sqlite-vec` não carregar).
26. **Pré-Filtragem Vetorial Segura:** A primeira implementação calcula busca vetorial exata apenas sobre o subconjunto já filtrado por `tenant_id`, `project_id` e `access_policy_id` em uma transação protegida por RLS. HNSW/iterative scans só podem ser habilitados quando um benchmark e teste de isolamento provarem que vetores não autorizados não afetam candidatos, ranking ou scores; RLS sozinha não satisfaz esse requisito para índices aproximados compartilhados.
27. **Fórmula de Scoring Inicial:**
    - `score_final = 0.45 * rrf(lexical, vector) + 0.25 * graph_proximity + 0.15 * authority_weight + 0.10 * recency_decay + 0.05 * hit_rate_boost`. `lexical` usa PostgreSQL FTS por padrão; ParadeDB BM25 é opcional.
    - Empates favorecem `status = 'approved'` e `is_inferred = false`.
28. **Roteador de Intenção:** Classifica em 6 intenções (`implement`, `debug`, `impact`, `review`, `business_qa`, `onboarding`). Se a confiança da classificação for `< 0.6`, aplica fallback seguro ativando os domínios centrais (`02`, `03`, `04`, `05`, `06`) e registra a decisão no modo `--explain`.
29. **Definição Formal de *Context Hit Rate*:** `hits / itens_enviados`, onde o denominador conta itens distintos efetivamente enviados em `sources[]` de Context Packs da mesma sessão `(tenant, projeto, ator, sessionId)`; resultados de busca direta não entram. `hit = 1` após evidência idempotente de leitura via `brain_knowledge_get`/REST com `sessionId`, citação de item entregue via learning/feedback, ou edição de `sourceUri` entregue vinculada ao mesmo `taskId` e a lease ativa do ator autenticado. Para edição automática, o Noema guarda no primeiro envio um hash SHA-256 de cada `sourceUri` que resolve para arquivo regular dentro do workspace configurado e compara o conteúdo no feedback. URIs remotas, arquivos ausentes/indisponíveis no envio e caminhos fora do workspace não geram baseline automático; `editedPaths` pode restringir os caminhos detectados, mas não criar evidência. Contadores e evidências são persistidos sob RLS; `hit_count` legado não substitui a taxa por sessão. Hits simultâneos na sessão reforçam arestas inferidas `CO_ACCESSED_WITH`. Meta de qualidade: `>= 60%`.
30. **Orçamento de Tokens:** Contagem padronizada via `tiktoken` (`cl100k_base`) com **margem de segurança de 10%**. Se o pacote mínimo exceder o `tokenBudget`, o sistema substitui código completo por `summary` + `sourceUri` para que o agente requisite sob demanda via `brain_knowledge_get`.
31. **Formato Obrigatório de Citações e Avisos:** Todo `Context Pack` retorna `sources[]` (`{ id, version, status, trustLevel, sourceOrigin, sourceUri, accessPolicyId, chunkIndex }`), `warnings[]` (lacunas, leases ativos, itens `untrusted`) e `conflicts[]`.
32. **Escopo das Metas de Latência (p95):** As metas (`< 150ms` lexical, `< 800ms` híbrida, `< 2s` Context Pack) são **hipóteses de trabalho** até que exista benchmark reproduzível medindo base real (até 100k chunks, 20 req/s concorrentes, busca vetorial exata com filtros RLS ativos). HNSW/`iterative_scan` só entram em benchmark de upgrade depois dos testes de isolamento do item 26; exclui-se a latência do LLM consumidor na IDE.

---

## Bloco 5 — MCP, API e Integração com Agentes (Itens 33–39)

33. **Catálogo Fechado de 13 Tools MCP:** O servidor MCP expõe **exatamente 13 tools canônicas** para manter o *context window* dos modelos limpo. Qualquer nova capacidade administrativa entra via CLI ou REST.
34. **Matriz Oficial: MCP × CLI × REST:**
    - *Leitura de Contexto, Busca, Impacto, Validação, Handoff, Proposta e Delegação:* **MCP (13 tools) + CLI + REST**.
    - *Administração, Conectores, Auditoria, Sync Edge e Export `.brainpack`:* **CLI + REST apenas**.
35. **Contratos de Erro e Paginação:** Operações de listagem usam paginação *cursor-based* (`limit`, `cursor`); operações de leitura de um único item, criação ou ação não são paginadas. Todas as tools e endpoints usam códigos de erro padronizados (`BRAIN_ERR_UNAUTHORIZED`, `BRAIN_ERR_NOT_FOUND`, `BRAIN_ERR_CONFLICT`, `BRAIN_ERR_POLICY_DENIED`, `BRAIN_ERR_RATE_LIMITED`).
36. **Autenticação de Agentes:** Agentes interativos usam fluxo **OIDC *On-Behalf-Of*** (token do usuário humano + `agent_id` no claim); agentes autônomos/CI/Cron usam **OIDC Client Credentials** (*service account* com escopo restrito). No Local-First Docker, usa API Key local.
37. **Transporte Oficial MCP:** **Streamable HTTP** (especificação MCP atual) para conexões remotas ao Hub e **`stdio`** para execução local ou via bridge `brain mcp connect <url>`.
38. **Nível Mínimo Garantido ("MCP Universal"):** Toda IDE suportada garante execução das **13 Tools** via MCP. Recursos extras (steering files, hooks de abertura) são melhorias progressivas nos adaptadores sem quebrar o núcleo.
39. **Fronteira *Thin Adapter* vs. Gateway:** O adaptador da IDE **apenas** detecta o path do workspace e configura o transporte MCP/instrução curta; detecção de projeto/branch, política OPA, montagem de contexto e handoff executam integralmente no Gateway/Core.

---

## Bloco 6 — Handoff e Execução Autônoma (Itens 40–48)

40. **Padrão do Handoff:** O checkpoint JSON é sempre obrigatório. Se `workingTreeDirty = true`, publica-se branch efêmera `handoff/<taskId>` no remoto Git; se não houver escrita no remoto, usa-se patch criptografado no MinIO quando habilitado. Sem nenhum meio de transferência disponível, a operação falha com erro acionável e não declara o código como transferido.
41. **Credenciais de Publicação Git:** No Edge local, usa as credenciais Git do próprio usuário (`gh` / SSH); no Hub/Command Center, usa **GitHub App / GitLab App** com permissão mínima (`contents:write`, `pull_requests:write`), nunca *push* direto para branches protegidas.
42. **Semântica de *Task & File Leases*:** São **avisos suaves não-bloqueantes** com TTL de 30 minutos (renovados por heartbeat da IDE). No modo offline não há lease; no `push` ou `resume`, divergências aparecem em `warnings[]`.
43. **Retomada de Handoffs Divergentes:** Nunca sobrescreve arquivos locais. Cria branch isolada `resume/<handoffId>` a partir do `baseCommitSha` e orienta merge/cherry-pick assistido.
44. **Checkpoints Parciais vs. Handoff:** Checkpoints automáticos na *Working Memory* são privados da sessão do usuário; tornam-se compartilháveis apenas quando consolidados explicitamente via `brain_create_handoff`.
45. **Contrato do Brain Runner:** Executa em sandbox isolado (container Docker ou subprocesso sem privilégios) com acesso somente leitura ao workspace, rede restrita apenas ao Brain e ao provedor local configurado (Ollama ou Apple `fm`, quando habilitado), e **apenas ferramentas de leitura, análise e geração de `draft`/PR**. Não executa deploys nem alterações em produção.
46. **Política de Comandos do Runner:** *Allowlist* estrita para utilitários de análise/teste (`git status`, `git diff`, linters, test runner do projeto) e *Denylist* explícita para comandos destrutivos ou de rede externa.
47. **Efeitos Externos Permitidos (`draft-only`):** O Brain Runner pode criar arquivos `draft` em `.brain/`, comentários em PRs e abrir PRs `[bot-draft]`. Apenas aprovações humanas no Command Center ou merge no Git promovem conhecimento para `approved`.
48. **Política de Provedores Locais do Runner:** Ollama continua sendo um provedor local opcional, com versões testadas por manifesto (tags e digest no release do Brain; por exemplo, `qwen2.5-coder:3b` e `llama3.2:3b`) e sem downloads sem configuração explícita. Em Macs compatíveis, Apple Foundation Models também pode ser selecionado explicitamente via CLI `fm`, desde que `fm available` confirme prontidão. O Noema não instala nem baixa o modelo Apple. Não há fallback remoto implícito. Ambos os provedores usam os mesmos limites, sandbox e permissões `draft-only`; suporte agêntico do Apple `fm` permanece experimental até validar tool calling MCP, streaming, cancelamento/timeouts e saída estruturada. Embeddings são uma capacidade separada: a seleção de `fm` para geração não implica suporte a embeddings.

---

## Bloco 7 — Segurança e Governança (Itens 49–59)

49. **Modelo Oficial de Autorização:** **OPA (Open Policy Agent)** combinando papéis (RBAC) e atributos (`tenantId`, `projectId`, `department`, `dataClassification`). *(Referências a Cedar ficam removidas da arquitetura oficial).*
50. **Conhecimento Organizacional Sem Projeto (`public-org`):** `tenant_id` é sempre obrigatório; para itens globais da organização (domínios `01`, `04`, `11`), usa-se `project_id = '__org__'` em `knowledge_items`. `audit_logs.project_id` usa `__org__` para eventos organizacionais e o ID real do projeto para eventos de projeto.
51. **Proteção em Profundidade no Banco (RLS):** Todas as tabelas multi-tenant no PostgreSQL ativam **Row-Level Security (RLS)** exigindo `app.current_tenant_id` e `app.allowed_policies` na sessão SQL, impedindo vazamento mesmo em queries diretas ou migrations.
52. **SLA de Cache e Revogação:** Cache LRU local ou Valkey opcional tem TTL máximo de **5 minutos** e é invalidado por evento (`knowledge.updated`, `policy.revoked`). Token offline do Edge expira em **24h (configurável até 7d)**.
53. **Requisito de Proteção do Banco Local Offline:** O SQLite do Local Edge deve ser criptografado em repouso via **SQLCipher** e a chave aleatória deve ficar no keychain do sistema operacional (macOS Keychain, Windows DPAPI, Linux Secret Service). O CLI já exige `better-sqlite3-multiple-ciphers` no perfil SQLCipher legado 4 e guarda a chave via keychain; o smoke test SQLCipher cobre arquivo cifrado, chave incorreta, restauração por cópia e rebuild; a matriz CI está configurada para Ubuntu, macOS e Windows. Nesta revisão não há resultado remoto disponível para confirmar os runners Linux/Windows; não declarar suporte multiplataforma validado até os jobs passarem. Após expirar o lease sem reconexão, o acesso offline deve ser bloqueado.
54. **Mitigação de *Prompt Injection*:** Fontes externas (`trustLevel = 'untrusted'`) são isoladas em blocos estruturados delimitados (`<external_data trust="untrusted">`) com instrução de sistema proibindo execução de comandos derivados desse bloco — além de filtros heurísticos de diretivas.
55. **Falsos Positivos de Segredos/PII:** Permite arquivo `.brainignore-secrets` versionado e revisado por AppSec (com registro obrigatório em `audit_logs`) para liberar falsos positivos específicos.
56. **Operacionalização LGPD:** `POST /v1/privacy/erase` exige stores PostgreSQL ativos e `DATABASE_SYSTEM_URL` com role `brain_system`; na mesma transação, seleciona e bloqueia os itens do sujeito (owner ou tag) no projeto, apaga `knowledge_items`, versões, embeddings e relações do grafo e escreve tombstones para sync Edge. A rota retorna contagens e `complete: false`: MinIO/backups não são apagados; dados operacionais legados sem `actor_id` não são processados; memórias, handoffs, tarefas, preferências e notificações pendentes com `actor_id` são apagados, incluindo perguntas e leases das tarefas removidas; históricos de aprovação e eventos de integração sem vínculo de ator permanecem fora do escopo; cópias Edge só removem dados após receber o tombstone no próximo sync; *crypto-shredding* e anonimização histórica de `audit_logs` não estão implementados. Não declarar exclusão completa até cobrir esses artefatos e validar restauração/retention.
57. **Trilha de Auditoria Imutável:** `audit_logs` é *append-only* (role da API sem permissão `UPDATE`/`DELETE` na tabela), registra obrigatoriamente `read_sensitive`, `search`, `create`, `update`, `approve`, `revoke`, `sync_pull`, `sync_push` e `export`, com retenção padrão de 1–5 anos.
58. **Matriz Única de Aprovação Humana:** Toda transição para `status = 'approved'` nos domínios `01`, `02`, `03`, `07`, `11`, alterações de políticas OPA e promoção de `is_inferred = true` exigem decisão humana explícita e autenticada via PR no Git, Command Center ou canal externo conectado conforme os itens 86–87. A aprovação por canal não dispensa autorização, registro no Approval Engine e auditoria.
59. **Escopo de Compliance:** Conformidade nativa com **LGPD** (minimização, mascaramento, exclusão) e controles técnicos alinhados a **SOC 2 Type II / ISO 27001** (auditoria imutável, criptografia em trânsito TLS 1.3 e repouso AES-256, isolamento multi-tenant).

---

## Bloco 8 — Edge, Sincronização e Conectores (Itens 60–67)

60. **Autenticação Offline:** O *offline lease* (access token de leitura local) dura **24h (máximo configurável 7d)**. A chave do banco Edge fica no keychain do OS; o refresh token, quando configurado, **exige conexão online com o Keycloak/Hub** para emitir um novo *offline lease* (nunca renova offline). Enquanto desconectado e dentro da janela válida, o SQLCipher permanece acessível; ao expirar sem reconexão, o acesso local é bloqueado. Perda de dispositivo é mitigada via revogação no Keycloak + expiração automática + criptografia SQLCipher.
61. **Protocolo Autoritativo de Sync (`protocols/edge-sync/`):** Baseado em cursor monotônico `sync_seq` do Hub + `content_hash` + `deleted_at` (tombstones), com paginação determinística e idempotência por `(item_id, source_version)`. O PostgreSQL serializa escritores pelo lock `(tenant_id, project_id)` até o commit; snapshots usam watermark fixo e paginação por ID.
62. **Criptografia de Dados Locais e Patches:** Patches no MinIO devem usar **AES-256-GCM** + assinatura HMAC-SHA256; o banco local deve usar **SQLCipher**; transporte usa **TLS 1.3**. O CLI exige SQLCipher no Edge e a cifragem foi exercitada em macOS arm64; outras plataformas ainda dependem da matriz CI e do critério do item 53. Uso direto de `EdgeDatabase` sem `requireSqlCipher` não oferece essa garantia.
63. **Ciclo de Vida do *Local Staging*:** Rascunhos em SQLite local têm cota configurável (padrão 500 MB), backup local opcional via `brain export` e limpeza automática de itens já promovidos ao Hub há > 30 dias.
64. **Sistemas Sem Suporte no Nango:** Utilizam o **Generic Webhook / HTTP Connector** do `connector-framework` ou importação via CLI (`brain ingest <path/url>`), com *rate-limit backoff* exponencial padrão.
65. **Ordem de Suporte dos Conectores:** (1) GitHub/GitLab + Jira/Linear; (2) Notion/Confluence/Figma/Drive; (3) Sentry/Datadog/Grafana; (4) HubSpot/Salesforce/Slack/Teams/e-mail. ClickUp é candidato de planejamento a ser habilitado quando seu conector, autenticação e mapeamento de permissões forem validados. A ordem indica prioridade, não implementação existente.
66. **Mapeamento de ACLs Externas:** Cada conector traduz grupos/permissões da origem (ex.: canal privado do Slack, projeto restrito do Jira, pasta do Drive) para `accessPolicyId` internos equivalentes; itens sem mapeamento explícito caem em `restricted-security` por padrão (*fail-closed*).
67. **Deduplicação Cross-Source:** Chave canônica `(external_provider, external_id)` + `canonical_uri`, evitando duplicação quando o mesmo requisito aparece no Jira e em uma referência do Git.

---

## Bloco 9 — Arquitetura, Stack e Operação (Itens 68–78)

68. **Topologia Oficial de Processos (Enxuta por Padrão):**
    - **Núcleo Obrigatório do Hub:** `apps/api` (Fastify + TypeBox: REST + `/mcp` HTTP + `/gateway`), `apps/worker` (TypeScript + **`pg-boss`** sobre o próprio PostgreSQL, eliminando fila externa obrigatória) e `PostgreSQL 16 + pgvector`.
    - **Serviços Sob Demanda / Opcionais:** `apps/web` (Next.js Command Center), `apps/ai-worker` (Python `Docling`/`Presidio` apenas quando PDF/Office ou PII de SaaS forem fontes ativas), `Temporal.io` (apenas para workflows multi-etapa longos), `Nango` (apenas com 2+ conectores SaaS OAuth), `MinIO`, `Keycloak + OPA` (nuvem corporativa), `Langfuse` e `Ollama`.
    - **Na Máquina do Usuário (Edge):** CLI/binário único Node.js/TS (`apps/cli` servindo `MCP stdio`, `brain ui` e `Brain Runner` local) + provedor de modelo opcional Ollama; em macOS compatível, Apple Foundation Models via `fm` também é opção explícita.
69. **Responsabilidade Única e Contratos:** **JSON Schema** em `protocols/` é o contrato canônico único (derivando tipos TypeScript e validações Fastify/TypeBox, MCP e CLI). Autenticação e Roteamento = `apps/api`; Busca e Montagem de Contexto = `packages/context-engine` + `retrieval`; Ingestão Git/AST e Jobs = `apps/worker` (`pg-boss`); Parsing PDF/PII = `apps/ai-worker`.
70. **Containers Obrigatórios vs. `--profile full`:**
    - *Compose Base Obrigatório:* **`PostgreSQL 16 + pgvector`** (que já hospeda dados, FTS, vetores, grafo e fila `pg-boss`) + `Ollama` (opcional para embeddings locais).
    - *Compose Full (`--profile full`):* adiciona `MinIO`, `Temporal.io`, `Keycloak`, `Nango`, `Langfuse`, `apps/ai-worker` e `apps/web`.
71. **Filas por Modo de Execução:** No Hub, **`pg-boss`** sobre PostgreSQL é a fila padrão para jobs, retries e cron. **Temporal.io** entra sob demanda para workflows de longa duração com timers externos e aprovações multi-etapa. No Local Edge, a fila durável é uma tabela SQLite em `packages/database-edge`; o agendador do `apps/cli` aciona jobs locais registrados nessa tabela. Edge não depende de PostgreSQL, Valkey ou Temporal.
72. **Cache Opcional (`Valkey 8`):** Cache em memória (LRU) no processo da API cobre instâncias únicas; **Valkey 8** entra apenas quando houver múltiplas réplicas horizontais da API compartilhando cache/leases.
73. **Versão Oficial do Banco:** **PostgreSQL 16 + `pgvector >= 0.8`** (imagem pinada por release, ex. `pgvector/pgvector:pg16`). Upgrade para **ParadeDB (`pg_search` BM25)** é suportado como extensão/imagem drop-in caso os evals exijam BM25 avançado.
74. **Localização do Schema e Migrations Drizzle:** Centralizados em **`packages/database`** (schema, migrations e políticas RLS em Drizzle ORM), consumido por `apps/api` e `apps/worker`, mantendo `packages/core` puro sem dependência de driver SQL.
75. **Migrations e Extensões no SQLite (Edge):** `packages/database-edge` gerencia migrations SQLite versionadas (`PRAGMA user_version`); se `sqlite-vec` falhar no carregamento, ativa automaticamente fallback para busca lexical `FTS5` pura com aviso em `warnings[]`.
76. **Ambientes Suportados:** Local Edge (macOS, Linux, Windows), Docker Compose (dev/small team) e Kubernetes via Helm + Terraform (produção corporativa).
77. **SLOs Completos do Produto:** Latência p95 (`< 150ms` lexical PostgreSQL FTS; `< 800ms` híbrida; `< 2s` Context Pack), disponibilidade Hub `99.5%`, `RPO = 1h`, `RTO = 4h`, limite recomendado de até `500k LOC` por serviço/projeto indexado. São metas sujeitas aos benchmarks do item 32.
78. **Política de Versões e Licenças:** Imagens Docker e dependências nunca usam `:latest` em produção (sempre pinadas por versão/digest); dependências do core restringem-se a licenças permissivas (`MIT`, `Apache-2.0`, `BSD-3-Clause`).

---

## Bloco 10 — Qualidade, Métricas e Aceite (Itens 79–84)

79. **Dataset Dourado de Avaliação (`tests/retrieval-evals/`):** Conjunto versionado com mínimo de 100 consultas reais (PT-BR e EN) cobrindo código, regras de negócio, ADRs e microserviços, avaliado automaticamente via `Promptfoo` + `Ragas` no CI.
80. **Definição Formal de "Zero Vazamento":** Nenhum dado de projeto/política não autorizada pode vazar por: (a) conteúdo textual, (b) existência de nó/aresta no grafo, (c) hit de cache local/Valkey ou (d) alteração de ranking/score. Validado pela suíte `tests/security/`.
81. **Validação Semântica de `VERIFIED_BY`:** Uma regra só é considerada coberta quando o teste vinculado existe no repositório, a execução CI aprovada para o SHA HEAD persistido de `main` corresponde ao arquivo e o vínculo refere o símbolo/regra via `@brain-rule` ou mapeamento explícito. O Noema atualiza o HEAD via push GitHub assinado em `refs/heads/main`; resultados CI incluem `repository` e SHA. Em projetos com vários repositórios, o item de teste precisa registrar `metadata.sourceRepository` correspondente ao resultado CI. Projetos sem GitHub configurado usam a validação de SHA do snapshot indexado.
82. **Definição de "Regra Sem Testes":** Regra `approved` de prioridade `high` ou `critical` que não possui nenhuma aresta `VERIFIED_BY` ativa apontando para um `test` existente no último commit da branch principal e com proveniência do repositório identificável quando o projeto contém vários repositórios.
83. **Limiares para Autodiscovery e Guardians:** Nenhum resultado de `Autodiscovery` (`confidence < 1.0`) pode bloquear PRs; bloqueio em modo `enforced` ocorre apenas para violações determinísticas (Semgrep, `dependency-cruiser`, OPA, ou regra `approved` marcada com `@brain-rule`).
84. **Governança de Aceite:** Cada estágio de construção exige: (1) suíte automatizada verde (unit, integration, security, evals) no CI, e (2) aprovação formal do Tech Lead e AppSec registrada no repositório.
85. **Estado de Bibliotecas e Implementação:** `docs/04-roadmap/open-source-building-blocks.md` é o catálogo normativo de dependências: “Em uso” significa presente e chamado pelo código; “Recomendada”, “Condicional” e “Avaliar” não significam dependência instalada nem comportamento disponível. Uma recomendação só vira “Em uso” após integração no código, atualização de manifests/lockfile e verificação de compatibilidade/licença. Decisões de arquitetura descrevem o destino requerido e não comprovam implementação. SQLCipher é efetivo somente para fluxos que exigem `requireSqlCipher` e nas plataformas com execução validada; isso ainda não prova paridade entre macOS, Linux e Windows sem resultados aprovados da matriz CI.
86. **Aprovação Humana por Canais Conectados:** Um conector pode entregar uma notificação de revisão e encaminhar uma resposta estruturada ao Approval Engine. O registro canônico da decisão é o Noema; Jira, ClickUp, e-mail, Slack ou Teams são canais de interação e não fontes de autorização independentes. A aprovação exige identidade humana autenticada, vínculo a tenant/projeto/proposta/versão e permissão de aprovação no momento da decisão; a decisão é idempotente e auditada com ator, canal, evento externo, horário e justificativa. Se Git é a fonte autoritativa do projeto, a aprovação no canal não substitui o merge do PR para publicar conhecimento oficial.
87. **Limites de MCP e Resposta em Canais:** MCP mantém o catálogo de exatamente 13 tools e não recebe uma tool para aprovar conhecimento oficial. O agente pode criar proposta e consultar seu estado; o canal externo coleta a ação explícita do humano e envia-a ao endpoint autenticado do Noema. Respostas livres, mensagens citadas/encaminhadas, reações ambíguas, timeout ou falha de integração nunca aprovam automaticamente. Timeout pode gerar lembrete ou escalonamento, mas não uma decisão.

