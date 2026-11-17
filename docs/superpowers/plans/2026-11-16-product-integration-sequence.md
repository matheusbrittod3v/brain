# Product Integration Sequence — Noema (Project Brain OS 2.0)

> **For agentic workers:** Use superpowers:executing-plans task-by-task. Checkbox (`- [ ]`) syntax for tracking. This plan orders *integration* work only; it does not shrink scope to an MVP and does not mark anything implemented because a stub exists.

**Goal:** Transform the current in-memory, security-hardened skeleton (49 tests, API/MCP funcionais em memória, helper RLS + roles provisionadas) into the integrated product defined by `docs/04-roadmap/construction-blueprint.md`, in vertical slices whose acceptance is verifiable end-to-end against real PostgreSQL 16 + pgvector.

**Current state (verified 2026-11-17):**
- P0 (cliente `brain_app`, `PostgresAuditLogger`, bootstrap/preflight) foi implementado e teve seus critérios exercitados em PostgreSQL 16 + pgvector descartável, com migrations reais. O núcleo de P1 (repositórios SQL, versões, grafo e retrieval) também passou por cenários live direcionados: insert de auditoria e bloqueio de update/delete, preflight recusa `BYPASSRLS`, tabelas knowledge falham fechadas sem GUCs, versões por mudança de hash, FTS/vetorial respeitando tenant/política, `__org__` sob autorização, matriz tenant/projeto/política nas tabelas cobertas da suíte live (a matriz ampliada atual cobre 26 tabelas públicas) e grafo sem acesso a projeto não autorizado.
- A matriz live em `tests/integration/postgres-rls-matrix-live.test.mjs` insere fixtures sintéticas e compara escopos estreitos/amplos em `organizations`, `projects`, `knowledge_items`, versões, embeddings, relações e auditoria. Ela complementa `tests/security/`, que continua cobrindo os adapters in-memory.
- A integração live de knowledge/graph tem fixture própria em `tests/integration/postgres-retrieval-graph-live.test.mjs`; o CI executa esse teste após bootstrap e migrations.
- P2 está em andamento: `brain_change_propose` persiste item/version e aprovação pelo runtime SQL; testes live confirmam busca SQL e fila pendente. O E2E `POST /ingest` → item/version/audit SQL → `/search` → Context Pack com fonte citada passou; `brain_search`/`brain_context_build` também foram exercitados no `/mcp` HTTP. A API local aplica `NOEMA_ALLOWED_POLICIES` e retorna `warnings[]` quando Ollama/modelo ou fila não estão disponíveis. O provedor `bge-m3` foi validado com geração e persistência vetorial reais; a restrição única/upsert passou em teste live. Os 40 jobs legados ainda elegíveis foram recuperados; 27 jobs inválidos ligados a conteúdo removido ou obsoleto seguem falhos sem reprocessamento. Busca vetorial agora usa query embeddings em REST e MCP, com fallback lexical/grafo; o teste live prova resultado sem correspondência FTS e o serviço local retornou resultados semânticos reais. O ledger de Context Hit Rate registra entrega, leitura, citação e edição sob lease por sessão; ranking usa a proporção persistida e arestas `CO_ACCESSED_WITH`. A integração live via REST/MCP foi repetida após reiniciar a API e cobre sessão compartilhada, idempotência, leitura, citação, item não entregue e edição com lease. REST e MCP detectam automaticamente diffs por SHA-256 entre entrega e feedback para arquivos locais elegíveis no workspace; URIs remotas/indisponíveis seguem fora da detecção. Ainda falta auditar o restante das rotas/tools em SQL.
- P4 handoff foi validado verticalmente: `brain handoff create` via CLI gravou handoff e lease no PostgreSQL; um runtime API recém-criado retomou pelo MCP e reportou divergências de branch, commit e lease. Isso cobre a retomada após perda do cache do processo, mantendo pendente a validação de branch efêmera/patch entre ferramentas externas.
- P3+ continuam pendentes conforme as caixas abaixo. A fatia de ingestão Git incremental agora tem checkpoint RLS por branch, serialização, Compare API com fallback, HEAD aceito pelo webhook, aposentadoria de fontes removidas/secret-bearing e reconciliação de snapshot. Testes unitários e live cobrem bootstrap, mudanças incrementais, rename/delete, force push, replay sem versões duplicadas e checkpoint não avançado após erro; a matriz RLS de 26 tabelas e a suíte pg-boss live também passaram. `brain_validate_implementation` verificou 16 regras sem violações. Permanecem outros itens P3/P5 e capacidades do CLI/Edge descritas abaixo.

**Global constraints:**
- Layer rule do blueprint (L5→L0) permanece; `apps/` são thin adapters.
- Nenhum caminho de leitura/escrita em produção sem `tenantId` + `allowedProjects` + `allowedPolicies` derivados de identidade confiável por requisição — nunca de payload.
- Persistência real usa `brain_app` (NOBYPASSRLS) via `withRlsTransaction`; `brain_system` (BYPASSRLS) só em migrations/workers internos auditados.
- Cada entrega só é "done" com seu critério verificável executado; stubs e in-memory não contam como implementação.

---

### P0 — Cliente de persistência `brain_app` + PostgresAuditLogger + bootstrap preflight (implementado e live-verificado)

**Depends on:** Estágio 0 completo (migrations + roles). **Blocks:** P1–P4.

- [x] `PostgresAuditLogger` implementando `AuditLogger` (`packages/audit-engine`), escrevendo em `audit_logs` via `withRlsTransaction` no pool `brain_app`, com contexto confiável e validação de evento.
- [x] Cliente `brain_app` em `packages/database`: pool dedicado lendo `DATABASE_URL`, sem fallback para URLs system/admin; falha rápida na ausência.
- [x] Bootstrap preflight verifica papéis/atributos, roles privilegiadas e estado de RLS; migrações usam `DATABASE_SYSTEM_URL` explicitamente.
- [x] Testes unitários e integração live: validação de papel inseguro, visibilidade sem/ com escopo, insert de auditoria e restrição append-only como `brain_app`.

**Critério verificável:** inserir evento via `PostgresAuditLogger` como `brain_app` aparece em `audit_logs` na mesma transação RLS; `UPDATE`/`DELETE` como `brain_app` falham (append-only); preflight falha quando role está errada.

---

### P1 — Repositórios SQL: knowledge + versions + graph + retrieval (implementação pronta; matriz de aceite parcial)

**Depends on:** P0. **Blocks:** P2, P3.

- [x] Repositório PostgreSQL de knowledge persiste itens, versões append-only por hash, tombstones e sync journal.
- [x] `PostgresGraphStore` faz travessia recursiva com tenant, projeto e política em cada salto.
- [x] `PostgresRetrievalEngine` combina FTS, similaridade vetorial exata filtrada por escopo, grafo e ranking normativo.
- [x] `__org__` só participa quando autorizado; testes live e unitários cobrem os caminhos SQL e in-memory.

**Critério verificável:** mesma suíte de contrato rodando contra in-memory e SQL (test matrix); `tests/security/` com 0% de vazamento cross-tenant/cross-project/cross-policy em Postgres real; reindex de mesmo conteúdo não duplica versão/chunk/aresta (idempotência por `content_hash`).

---

### P2 — Composição API/MCP sobre SQL (primeira integração vertical utilizável)

**Depends on:** P0, P1. **Blocks:** P3, P4.

**Primeira fatia vertical utilizável:** ingest de um arquivo `.brain/*.md` via `POST /v1/projects/:id/ingest` → persistência em `knowledge_items` + `knowledge_item_versions` (+ arestas de âncoras) + `audit_logs` → leitura via `brain_search` e `brain_context_build` no MCP respondendo do Postgres com RLS ativo.

- [x] Rotas REST centrais (`ingest`, `context`, `search`, `search/feedback`) e as 13 tools MCP usam runtime SQL/RLS; suítes PostgreSQL live cobrem persistência, busca/citação e feedback, e o novo cenário MCP chama as 13 tools e relê proposta, handoff, memória e tarefa após criar um runtime novo. `brain_validate_implementation` verifica guardas em 17 regras sem violações.
- [x] `PostgresAuditLogger` é o audit padrão na API/MCP quando o runtime PostgreSQL está ativo; in-memory só é injetado pelos testes.
- [x] Não há fallback `dev-key`: a API falha no startup sem `NOEMA_LOCAL_API_KEY`, coberto por teste.
- [x] Embeddings indisponíveis não bloqueiam ingestão textual: API verifica Ollama/modelo, evita enfileirar jobs que falhariam e retorna `warnings[]`; testes cobrem provedor/modelo ausente e busca lexical após ingestão.
- [x] Embeddings: provedor Ollama/`bge-m3` ativo foi confirmado e jobs reais persistiram vetores 1024d no PostgreSQL; teste live cobre upsert idempotente. Busca REST/MCP usa query embeddings com fallback. Os 40 jobs legados elegíveis foram recuperados; 27 jobs sem conteúdo vigente permanecem falhos e não são reaplicáveis.
- [x] Busca vetorial no caminho de produto: REST `/search` e `/context`, `brain_search` e `brain_context_build` agora geram query embeddings com o provedor configurado e preservam busca lexical/grafo quando Ollama falha ou não está disponível. O teste live com vetor controlado prova resultado sem correspondência lexical nos quatro caminhos; consulta real via API com Ollama/`bge-m3` também retornou os documentos pertinentes em 259 ms nesta execução.
- [x] Feedback útil e Context Hit Rate: `hit_count` legado permanece separado; o ledger RLS registra fonte Context Pack distinta por ator/sessão, evidência de leitura/citação e edição vinculada a lease ativo, e ranking usa `context_hit_count / context_sent_count`. Testes live REST/MCP cobrem idempotência, item não entregue, leitura sem sessão, isolamento e edição com lease/caminho exatos; relações inferidas `CO_ACCESSED_WITH` também são verificadas no PostgreSQL. O SHA-256 antes/depois descobre automaticamente alterações em fontes locais elegíveis; caminhos remotos ou indisponíveis não geram evidência automática.

**Critério verificável:** cenário E2E — ingest cria item v1 + audit; `brain_search` com sessão autorizada retorna o item; mesma busca com `allowedPolicies` sem a política do item retorna vazio; audit row existe com a política do item; `knowledge_item_versions` contém o snapshot v1. Tudo contra Postgres real.

---

### P3 — Jobs/worker `pg-boss` + ingestão Git incremental

**Depends on:** P1, P2. **Blocks:** P4.

- [ ] `apps/worker` com `pg-boss` sobre o mesmo Postgres (tabelas da fila criadas/owned por `brain_system`; jobs executam escrita de conhecimento via contexto de sistema auditado, não via GUCs de usuário). `startWorker` registrou as seis filas no Postgres local e os consumidores de aprovação, embeddings, Git, memory-decay, SaaS e notificação concluíram jobs reais; o Git job comprovou bloqueio de token sintético antes da persistência. As integrações live Git/SaaS exercitam ingestão de regra Git `restricted-security`, auditoria `audit_logs` sob `brain_app`/RLS, rejeição de políticas fora do escopo, dois registros SaaS, ACL de canal privado e rejeição antes do upsert quando tenant/projeto divergem do job. Ambas persistem versões e `sync_changes`. O teste live também enfileira embeddings de item persistido `restricted-security`, confirma que o worker usa o snapshot versionado (ignora o texto enviado no job), grava vetores com a mesma política e cria auditoria `embed_item` sob RLS; um endpoint local determinístico evita depender de Ollama/modelos instalados na CI. Um lembrete de aprovação pendente também foi enfileirado em live: o evento e a auditoria `approval_reminder` ficaram no projeto/política esperados. O encerramento gracioso foi validado num processo live por `SIGTERM`, incluindo parada ordenada e fechamento das conexões. O digest de notificação é enviado a um webhook sintético live, marcado como entregue e auditado sob a política/ator do outbox. Memory-decay foi testado com dois projetos: como `brain_system` tem `BYPASSRLS`, as exclusões agora restringem explicitamente projeto e política; dados do outro projeto sobreviveram, e o job gravou auditoria com contagens. Os seis consumidores têm evidência live de escopo/auditoria; faltam os perfis operacionais restantes.
- [ ] Ingestão Git: API GitHub com `sourceOrigin` internal vs external_reference e checkpoint incremental por commit implementados; testes live confirmam incremental, rename/delete, force push, reconciliação, replay e isolamento do mesmo `(sourceUri, contentHash)` entre tenants/projetos. Vetores agora usam o `sourceVersion` que ficou persistido para evitar embeddings apontando para commits sem versão de item. Outros casos de aceite do blueprint §4 ainda precisam de auditoria.
- [ ] Pipeline: scan de segredos (Gitleaks) → sanitização PII configurada → chunking → embeddings → upsert itens/versões/arestas com isolamento de erro por arquivo. `scanForSecrets` exige Gitleaks e falha fechado; quando `AI_WORKER_URL` está configurado, REST/sync push, eventos SaaS e jobs de Git/SaaS sanitizam título e conteúdo antes de persistência ou embeddings. Testes API verificam ingestão REST e webhook SaaS; testes do worker verificam Git/SaaS e bloqueio do upsert em falha do redactor. A sanitização continua opcional sem configuração. Ainda faltam teste live PostgreSQL específico para esses caminhos, Docling PDF/Office, avaliação LGPD multi-idioma e exceções por repositório.

**Critério verificável:** reindexar o mesmo commit duas vezes não duplica chunks, embeddings nem arestas (critério de saída do Estágio 2); falha em 1 arquivo registra o erro no item e segue o restante.

---

### P4 — Gateway `/mcp` HTTP + CLI + handoff Git-backed

**Depends on:** P2 (contratos estáveis sobre SQL). **Blocks:** P5.

- [x] `apps/api` expõe as 13 tools `brain_*` via `/mcp` Streamable HTTP; teste de paridade confere o catálogo e a suíte PostgreSQL live agora chama as 13 com persistência/RLS e retoma handoff/proposta/memória/tarefa após runtime novo.
- [x] `apps/cli`: `brain init`, `brain context`, `brain handoff`, `brain validate`, `brain sync pull/push` (sync como contrato, Edge em P5) e `brain runner up` implementados; 18 testes CLI passam e `brain context build` foi executado contra a API local SQL/RLS, retornando sessão, Context Hit Rate e 25 fontes. O fluxo integrado Edge offline/Hub permanece em P5.
- [x] `agent-handoff` persistido em SQL com lease e verificação de divergência: smoke live criou pela CLI e retomou via MCP após criar um runtime API novo; divergências de branch, commit e lease foram reportadas. Branch efêmera/patch e validação com IDEs externas seguem fora deste aceite.

**Critério verificável:** handoff criado na CLI é retomado via MCP em outra sessão com mesma identidade; divergência de commit é detectada e reportada.

---

### P5 — Demais capacidades normativas (não cortar do produto)

**Depends on:** P3–P4. Sem critério de corte: Edge offline (SQLite FTS5/sqlite-vec/SQLCipher + sync delta filtrada por OPA), OPA/Keycloak no perfil corporativo, observability OTel, guardians + GitHub Checks, `apps/web` Command Center, connector-framework/Nango, approval-engine, Edge Runner local. Cada um segue os Estágios 4–5 do blueprint com suas suítes (`retrieval-evals` 100+ queries, `security`, cross-platform CLI/Edge).

---

## Estratégia e resultado da validação live do DB

1. **Postgres descartável efêmero:** executado em `pgvector/pgvector:pg16` na porta `54329`, sem volume montado, com credenciais aleatórias; bootstrap e migrations reais foram aplicados antes das duas suítes live. O container é removido após a verificação.
2. **CI service container:** GitHub Actions já provisiona `pgvector/pgvector:pg16`, executa bootstrap + migrations e roda oito suítes live: `postgres-live`, `postgres-api-context-live`, `postgres-verified-by-live`, `postgres-retrieval-graph-live`, `postgres-mcp-proposal-live`, `postgres-mcp-tools-live`, `postgres-rls-matrix-live` e `postgres-worker-live`.
3. **Alternativa sem Docker:** `embedded-postgres` (npm) baixando binário PG16 em diretório temporário por test run.
4. Em todos os casos: `.env.test` próprio, `POSTGRES_ADMIN_PASSWORD` aleatório por run, e proibido apontar `DATABASE_*_URL` para o banco do desenvolvedor. A validação local executada não usou o serviço PostgreSQL existente nem seu volume.

## Testes de segurança que exigem Postgres real (não substituíveis por in-memory)

- Fail-closed sem GUCs: `SELECT` em qualquer uma das 7 tabelas como `brain_app` retorna 0 linhas.
- Cross-tenant/cross-project/cross-policy: cenários direcionados cobrem isolamento nas 7 tabelas e na travessia do grafo (CTE), incluindo arestas cross-project e escopo `__org__`; a matriz não testa todas as combinações possíveis.
- Append-only: `UPDATE`/`DELETE` em `audit_logs` como `brain_app` negados; `INSERT` respeita `WITH CHECK`.
- Recriação de tabela por `brain_system` mantém defaults `SELECT, INSERT` para `brain_app` (regressão do achado C) — ainda sem cenário live dedicado.
- FK `ON DELETE CASCADE` de embeddings (LGPD item 56) e tombstone propagation — tombstones são exercitados pela integração de sync; cascade ainda sem cenário live dedicado.
- Vetorial exata retorna apenas o subconjunto autorizado sob RLS ativo.
