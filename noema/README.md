# Noema

> **Project Brain OS 2.0** — Cérebro universal para engenharia de software, negócios e agentes de IA.

O **Noema** conecta código, arquitetura, regras de negócio, decisões históricas, tarefas e continuidade entre IDEs (**Antigravity, Codex, Kiro, Cursor, Claude Code, VS Code**), operando tanto em modo **Local Edge (Offline)** quanto em **Enterprise Hub (Online)**.

## Estrutura do Monorepo

- `apps/api` — API REST (Fastify + TypeBox) + `/mcp` HTTP + `/gateway`
- `apps/cli` — CLI multiplataforma (`noema`)
- `apps/worker` — Workers TypeScript + `pg-boss`
- `apps/agent-runner` — Subagente leve em background (fila e cron)
- `packages/core` — Entidades e contratos puros (`KnowledgeItem`, `BrainErrorCode`)
- `packages/database` — Schema Drizzle, migrations e políticas RLS (PostgreSQL + `pgvector`)
- `protocols/` — Contratos canônicos em JSON Schema (`context-pack`, `agent-handoff`, `knowledge-events`, `project-manifest`, `runner-tasks`, `edge-sync`)
- `infra/docker/` — Infraestrutura local via Docker Compose

## Início Rápido (Estágio 0)

```bash
cp .env.example .env
npm install
npm run infra:up
npm run -w @noema/database db:bootstrap-roles
npm run -w @noema/database db:migrate
npm run typecheck
```

## Banco de Dados e Migrations (`@noema/database`)

As migrações SQL ficam versionadas em `packages/database/drizzle/` e já incluem, na ordem correta de inicialização:
1. Extensões obrigatórias (`pgcrypto` e `vector` para `pgvector >= 0.8`, dimensão `1024`).
2. Tabelas do schema Drizzle (`organizations`, `projects`, `knowledge_items`, `knowledge_item_versions`, `knowledge_embeddings`, `knowledge_relations`, `audit_logs`) e chaves estrangeiras (incluindo FK composta `ON DELETE CASCADE` de `knowledge_embeddings` para `knowledge_items`).
3. Índices de busca lexical (FTS/GIN), tags, filtros compostos, pré-filtragem para busca vetorial exata (sem índice aproximado HNSW até que benchmarks e testes de isolamento de políticas sejam aprovados) e travessia do grafo.
4. Políticas de *Row-Level Security* (RLS) explícitas (`FOR ALL` com `USING` e `WITH CHECK` correspondentes) habilitadas em todas as 7 tabelas (`organizations`, `projects`, `knowledge_items`, `knowledge_item_versions`, `knowledge_embeddings`, `knowledge_relations` e `audit_logs`), isolando por tenant, projetos permitidos e políticas de acesso permitidas.

Comandos disponíveis (executados a partir de `noema/`):

```bash
# Gerar novas migrations a partir de packages/database/src/schema.ts (funciona offline, sem PostgreSQL rodando)
npm run -w @noema/database db:generate

# Criar/atualizar roles, grants e extensões usando DATABASE_ADMIN_URL
npm run -w @noema/database db:bootstrap-roles

# Aplicar migrations pendentes no PostgreSQL 16 (requer banco ativo, ex.: npm run infra:up)
npm run -w @noema/database db:migrate
```

`db:bootstrap-roles` precisa ser executado antes de `db:migrate`. O bootstrap usa `DATABASE_ADMIN_URL` apenas para criar/atualizar `brain_app` e `brain_system`, instalar `pgcrypto`/`vector`, conceder `USAGE` para a aplicação e `USAGE, CREATE` para o sistema em `public`, e definir default privileges futuros de `SELECT, INSERT` (sem `UPDATE`/`DELETE`). Ele não tenta conceder privilégios em tabelas, pois elas ainda não existem na instalação fresca. As migrations usam obrigatoriamente `DATABASE_SYSTEM_URL`; a aplicação usa `DATABASE_URL`, que deve autenticar como `brain_app`. Não há fallback entre essas conexões. `brain_app` é `NOSUPERUSER NOBYPASSRLS` e não é dono das tabelas; `brain_system` é `NOSUPERUSER BYPASSRLS` e é dono dos objetos criados nas migrations. O SQL da migration, executado pelo proprietário, concede DML explicitamente às tabelas atuais exceto `audit_logs`, que permite à aplicação apenas `SELECT` e `INSERT`. Default privileges só se aplicam a objetos futuros criados por `brain_system`; novas tabelas que precisem de UPDATE/DELETE devem receber grant explícito na migration responsável. Decisão deliberada: os grants das tabelas atuais são responsabilidade exclusiva da migration que as cria (não há grants em tabelas inexistentes no bootstrap); reexecutar o bootstrap restaura atributos de role, privilégios de schema, extensões e default privileges, mas não reescreve grants de tabelas já existentes — divergências manuais nesses grants devem ser corrigidas por DBA ou por nova migration.

> **Nota sobre `db:generate` offline:** `db:generate` e `db:check` não abrem conexão e funcionam sem `DATABASE_SYSTEM_URL` definida; já `db:migrate` (e qualquer comando que conecte) falha rápido sem uma `DATABASE_SYSTEM_URL` válida autenticando como `brain_system`.
>
> **Nota sobre privilégios da conexão admin:** para criar `brain_system` com `BYPASSRLS`, a [documentação oficial do PostgreSQL 16](https://www.postgresql.org/docs/16/sql-createrole.html) exige, no `CREATE ROLE`, ser superuser **ou** a própria role possuir `BYPASSRLS` ("Only superuser roles or roles with BYPASSRLS can specify BYPASSRLS"). Já no [`ALTER ROLE`](https://www.postgresql.org/docs/16/sql-alterrole.html), uma role não-superuser com `CREATEROLE` precisa de `ADMIN OPTION` sobre a role-alvo **e** só pode alterar `CREATEDB`/`REPLICATION`/`BYPASSRLS` se ela própria possuir o atributo correspondente. Como o bootstrap executa `CREATE` e `ALTER` com `BYPASSRLS`, a recomendação prática é usar uma conexão admin superuser; no Docker local esse papel é `brain_admin`.
>
> **Nota sobre objetos e memberships legados (risco aberto):** a proteção por RLS não depende de quem criou a tabela, e sim das policies habilitadas e da role consultante — o owner da tabela normalmente bypassa RLS (salvo com `FORCE ROW LEVEL SECURITY`), e superusers/roles `BYPASSRLS` sempre bypassam. Tabelas de propriedade de roles legadas (ex.: o antigo superuser `brain`) **continuam protegendo** `brain_app`, desde que a aplicação não seja a owner nem consiga assumir (`SET ROLE`) uma role privilegiada. O risco residual é o inverso: o bootstrap não audita nem revoga memberships/ownerships legados — se `brain_app` (ou outra role usada pela aplicação) herdar membership de uma role `BYPASSRLS`, superuser ou owner das tabelas, o isolamento é contornado. Ao migrar um banco existente, revise manualmente `pg_auth_members` e a propriedade dos objetos.
>
> **Nota sobre volume Docker existente:** `POSTGRES_USER`/`POSTGRES_PASSWORD` só têm efeito na primeira inicialização do volume (`initdb`). Um volume `pgdata` criado antes da mudança para `brain_admin` preserva o superuser antigo (`brain`), e o bootstrap falhará ao conectar como `brain_admin` até que você migre as credenciais. Para adotar a nova role admin **sem perder dados**, conecte com o superuser antigo e ajuste as roles manualmente (ex.: `ALTER ROLE brain RENAME TO brain_admin;` e `ALTER ROLE brain_admin PASSWORD ...`, atualizando `.env`), ou faça backup com `pg_dump`/`pg_dumpall`, recrie o volume e restaure. Um reset destrutivo (`docker compose down -v`, que apaga todos os dados locais) é estritamente opt-in e deve ser precedido de backup — não é o passo padrão.

Os valores em `.env.example` são exemplos locais descartáveis. Em produção, injete credenciais por um secret manager, limite quem pode ler a conexão admin e o `.env`, restrinja o acesso a `pg_stat_activity` e aos logs do PostgreSQL, e defina uma política de rotação. O bootstrap passa senhas como parâmetros para `quote_literal` antes de montar o utility statement e não imprime senhas; ainda assim, o comando final e, conforme a configuração, parâmetros de consulta podem aparecer em `pg_stat_activity` ou logs do servidor. Proteja esses canais e mantenha rotação; não há garantia de ausência de exposição neles.

> **Nota sobre Execução e Idempotência:** O Drizzle registra e aplica cada arquivo de migration apenas uma vez por banco (via journal em `packages/database/drizzle/meta/_journal.json`). As instruções de extensões, índices (`IF NOT EXISTS`) e políticas RLS (`DROP POLICY IF EXISTS` antes de `CREATE POLICY`) também são escritas de forma idempotente onde suportado pelo PostgreSQL.
>
> **Nota sobre Contexto de Sessão RLS (Fail-Closed) e Separação de Roles:**
> - **GUCs Obrigatórios por Conexão/Transação:** Em tempo de execução, a camada de aplicação deve configurar `app.current_tenant_id`, `app.allowed_projects` (lista separada por vírgula, incluindo `'__org__'` quando o escopo organizacional for autorizado) e `app.allowed_policies` (lista separada por vírgula) via `SET LOCAL` em cada transação PostgreSQL, derivados da identidade autenticada.
> - **Fail-Closed:** As políticas RLS nas 7 tabelas utilizam `current_setting(..., true)` e operam em modo **fail-closed** (falha fechada): sem esses GUCs configurados na sessão, nenhuma leitura ou escrita nas tabelas protegidas por RLS é permitida.
> - **Separação de Roles (`brain_system` vs. Role da Aplicação):** Conexões normais da API/aplicação devem utilizar uma role **não-owner** e **sem `BYPASSRLS`** para que o RLS seja sempre imposto pelo PostgreSQL. Uma role dedicada e auditada (`brain_system` com `BYPASSRLS`) é reservada exclusivamente para workers internos e execução de migrations (por isso `FORCE ROW LEVEL SECURITY` não é utilizado).




