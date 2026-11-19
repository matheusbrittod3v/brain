---
name: git-workflow-craftsman
description: >-
  Padrões profissionais de versionamento com Git: Conventional Commits estritos,
  estratégias Git Flow / Trunk-Based Development, commits atômicos, mensagens
  semânticas com contexto arquitetural e higiene de histórico limpo e linear.
---

# Git Workflow & Conventional Commits Craftsman

Este guia define as convenções obrigatórias para versionamento, branching e mensagens de commit em projetos modernos e corporativos.

---

## 1. Padrão Conventional Commits 1.0.0

Cada commit deve comunicar com clareza o tipo de alteração, o escopo arquitetural afetado e a motivação técnica da mudança.

### 1.1. Estrutura da Mensagem
```text
<tipo>(<escopo>): <descrição no imperativo e em minúsculas>

[corpo opcional explicando o "porquê" e o contexto arquitetural]

[rodapé opcional com BREAKING CHANGE ou referências de issues/tarefas]
```

### 1.2. Tipos Canônicos de Commit
| Tipo | Significado | Exemplo |
| :--- | :--- | :--- |
| `feat` | Nova funcionalidade para o usuário ou API | `feat(auth): add passkey authentication with WebAuthn` |
| `fix` | Correção de bug ou regressão | `fix(retrieval): resolve cache miss on hybrid search` |
| `refactor` | Mudança interna no código sem alterar comportamento externo | `refactor(graph): replace nested loops with adjacency map` |
| `perf` | Melhoria de desempenho, latência ou uso de memória | `perf(database): add composite index for test results lookup` |
| `test` | Adição ou refatoração de testes automatizados | `test(rules): add E2E suites for BR-BRAIN-008 and 009` |
| `docs` | Atualização de documentação, ADRs ou READMEs | `docs(architecture): update system topology diagram` |
| `style` | Formatação, linting, ponto-e-vírgula (sem mudança de lógica) | `style(web): standardize tailwind color tokens` |
| `chore` | Manutenção de dependências, scripts de build ou configs | `chore(deps): update bun to v1.4.4 and turbo to v2.11` |
| `ci` | Pipelines de CI/CD, GitHub Actions, Dockerfiles | `ci(docker): optimize multi-stage build caching` |

### 1.3. Escopos Obrigatórios (Scopes)
Sempre declare o componente do monorepo ou domínio afetado:
- `(api)`: Rotas, controllers, middlewares do backend.
- `(web)`: Componentes Nuxt/Vue, stores, composables e páginas.
- `(auth)`: CASL, RBAC, tokens JWT, permissões.
- `(graph)`: Algoritmos de travessia, topologia e relações.
- `(retrieval)`: Motores de busca vetorial, BM25, ParadeDB.
- `(database)`: Migrations Drizzle, schemas PostgreSQL, RLS.
- `(mcp)`: Ferramentas e protocolos MCP.
- `(worker)`: Tarefas assíncronas, BullMQ/Valkey runners.

### 1.4. Regras de Ouro da Mensagem
1. **Imperativo Presente**: Use `add`, `fix`, `refactor`, `enforce` (nunca `added`, `fixes`, `fixing`).
2. **Minúsculas no Título**: Primeira letra após os dois-pontos sempre em minúscula (sem ponto final).
3. **Foco no "Porquê"**: O diff já mostra *o que* mudou; o corpo do commit deve explicar *o motivo* e *alternativas rejeitadas*.
4. **Breaking Changes Explícitas**:
   ```text
   feat(api)!: migrate auth header from X-API-Key to Authorization Bearer

   BREAKING CHANGE: endpoints now reject X-API-Key header. Clients must pass Authorization: Bearer <token>.
   ```

---

## 2. Estratégia de Branching (Trunk-Based & Git Flow)

Adotamos **Trunk-Based Development com Short-Lived Feature Branches**:

```text
main ───────────●───────────────────────●────────── (produção estável)
                 \                     /
feat/auth-jit     ●──────●──────●─────● (branch curta, max 2 dias, rebase na main)
```

### 2.1. Nomenclatura de Branches
- `feat/<identificador>-<descrição-curta>`: `feat/BR-008-knowledge-provenance`
- `fix/<identificador>-<descrição-curta>`: `fix/SEC-001-rls-tenant-leak`
- `refactor/<módulo>-<descrição>`: `refactor/web-cytoscape-layouts`
- `perf/<módulo>-<descrição>`: `perf/db-knowledge-search-vector`

### 2.2. Commits Atômicos
- Cada commit deve representar **uma única unidade lógica de trabalho**.
- O projeto deve compilar e passar nos testes em **cada commit individual** (preserva `git bisect`).
- Evite commits aglomerados como *"ajustes gerais"* ou *"wip"*.

### 2.3. Higiene de Rebase e Histórico Linear
- Mantenha o histórico limpo e linear:
  ```bash
  # Atualizar branch de feature com a main sem criar merge commit inútil:
  git checkout feat/sua-feature
  git fetch origin
  git rebase origin/main
  ```
- Use `git rebase -i HEAD~n` para condensar commits intermediários de "fix typo" antes de abrir PR.
- No merge do PR, utilize **Squash & Merge** ou **Rebase & Fast-Forward**, mantendo a `main` com histórico legível.

---

## 3. Checklist Pré-Commit e Pré-Push

Antes de executar `git commit` e `git push`:
1. `git diff --staged`: Revise cada linha que está sendo adicionada.
2. **Varredura de Segredos**: Nunca comite chaves privadas, senhas reais ou tokens JWT.
3. **Execução de Testes**: Rode os testes relevantes (`bun test`) para garantir zero quebras.
4. **Respeito aos Limites**: Verifique se nenhum arquivo criado/editado ultrapassa 700 linhas.
