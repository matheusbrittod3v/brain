# Guia de Estrutura de Conhecimento Versionável

O **Project Brain OS 2.0** separa claramente a **Fonte da Verdade (Source of Truth)** por tipo de conhecimento para evitar conflitos entre edições no Git e edições no Dashboard. Em caso de diferença, prevalece [00-normative-decisions.md](../00-normative-decisions.md); este guia detalha a resolução de caminhos.

- **Conhecimento Oficial (Domínios 01–04, 07, 11):** **O Git é a fonte da verdade.** Toda aprovação feita no *Project Command Center* (`apps/web`) ou proposta via `brain_change_propose` gera automaticamente um commit ou Pull Request no repositório Git; o PostgreSQL atua como índice estruturado, grafo e cache consultável.
- **Conhecimento Operacional e Dinâmico (Domínios 05, 06, 08–10, 12):** **O PostgreSQL é a fonte da verdade** (símbolos indexados por commit, tarefas sincronizadas, logs de observabilidade, *handoffs*, memórias episódicas e *Context Hit Rate*).

---

## 1. Localização, Precedência e Mapeamento para os 12 Domínios

O manifesto `.project-brain.json` declara `ownerRepo`, `knowledgePaths`, `subProjects` e, opcionalmente, `knowledgePrecedence`:
1. Quando `knowledgePrecedence` está presente, os caminhos listados são consultados na ordem indicada para resolver IDs sobrepostos.
2. Sem `knowledgePrecedence`, os `knowledgePaths` são consultados na ordem em que aparecem no manifesto.
3. Se nenhum caminho configurado contiver o item, `.brain/` dentro do `ownerRepo` é o padrão para conhecimento do projeto.
4. O repositório central fornece conhecimento organizacional em `data/knowledge/organization/` e políticas em `data/knowledge/policies/`. `data/knowledge/projects/{project-id}/` fornece conhecimento de projeto apenas quando esse repositório é o `ownerRepo` ou recebe precedência explícita no manifesto.

> **Conflito entre repositórios Git oficiais:** `ownerRepo` é a fonte oficial para domínios `01–04`, `07` e `11`. Se o mesmo ID surgir em mais de um caminho configurado, vence o primeiro segundo `knowledgePrecedence` (ou a ordem do manifesto, se ausente); o sistema registra a colisão e alerta no *Knowledge Health Monitor*. Não há desempate automático por timestamp ou hash.

Estrutura interna de diretórios (idêntica em `.brain/` e `data/knowledge/projects/{project-id}/`, além de `data/knowledge/policies/` para políticas organizacionais), mapeada aos **12 domínios lógicos** (conforme [00-normative-decisions.md](../00-normative-decisions.md)):
- `00-overview/` → Domínio `01`
- `01-business/` → Domínios `02`, `09`, `10` (`kpis/`)
- `02-product/` & `05-execution/` → Domínio `06`
- `03-architecture/` → Domínios `03`, `07` (`decisions/`), `10` (`data-models/`)
- `04-engineering/` & `policies/` → Domínios `04`, `11` (`security-standards.md`, `data/knowledge/policies/`, `.brain/04-engineering/policies/`)
- `06-operations/` → Domínio `08`
- `08-agent-memory/` → Domínio `12`
- Código-fonte indexado (AST/SCIP) → Domínio `05`

```text
.brain/ (ou data/knowledge/projects/{project-id}/)
├── 00-overview/                  # Identidade, visão e glossário
│   ├── vision.md
│   ├── scope.md
│   ├── stakeholders.md
│   └── glossary.md
│
├── 01-business/                  # Regras de negócio, processos e KPIs
│   ├── business-model.md
│   ├── business-rules/           # Arquivos YAML/MD tipados (ex: BR-SUB-014.yaml)
│   ├── processes/
│   ├── customer-journeys/
│   ├── pricing/
│   ├── financial-rules/
│   └── kpis/
│
├── 02-product/                   # Requisitos, features e critérios de aceite
│   ├── requirements/             # Ex: REQ-SUB-008.md
│   ├── features/
│   ├── user-stories/
│   ├── acceptance-criteria/
│   └── roadmap.md
│
├── 03-architecture/              # Arquitetura, contratos e decisões (ADRs)
│   ├── system-context.md
│   ├── components/
│   ├── services/
│   ├── data-models/
│   ├── integrations/
│   ├── api-contracts/            # OpenAPI / AsyncAPI / Protobuf
│   └── decisions/                # Ex: ADR-021.md
│
├── 04-engineering/               # Padrões, testes e Definition of Done
│   ├── coding-standards.md
│   ├── testing-strategy.md
│   ├── security-standards.md
│   ├── development-workflow.md
│   └── definition-of-done.md
│
├── 05-execution/                 # Tarefas, épicos, bloqueios e releases
│   ├── tasks/
│   ├── epics/
│   ├── milestones/
│   ├── blockers/
│   └── releases/
│
├── 06-operations/                # Ambientes, deploys, runbooks e incidentes
│   ├── environments/
│   ├── deployments/
│   ├── runbooks/
│   ├── incidents/
│   └── monitoring/
│
├── 07-intelligence/              # Lições aprendidas, riscos e hipóteses
│   ├── lessons-learned/
│   ├── risks/
│   ├── opportunities/
│   ├── assumptions/
│   └── research/
│
└── 08-agent-memory/              # Continuidade e memória validada de agentes
    ├── handoffs/
    ├── validated-learnings/
    ├── agent-instructions/
    └── session-summaries/
```

---

## 2. Templates Recomendados (`data/knowledge/templates/`)

### A. Template de Regra de Negócio (`BR-XXX-NNN.yaml`)
```yaml
id: BR-DOM-001
type: business_rule
project: "<project-id>"
title: "<Título curto e claro>"
status: draft # draft | approved | deprecated | superseded
priority: high # low | medium | high | critical
owner: "<equipe-ou-papel>"
version: 1
access_policy: "internal-project"

description: >
  Descrição objetiva da regra de negócio.

conditions:
  - "<Condição prévia 1>"

effects:
  - "<Efeito esperado 1>"

exceptions:
  - "<Exceção explícita 1>"

related:
  requirements: []
  services: []
  decisions: []
  tests: []
```

### B. Template de Decisão Arquitetural (`ADR-NNN.md`)
```markdown
---
id: ADR-001
type: architecture_decision
project: "<project-id>"
status: draft # draft | approved | deprecated | superseded
superseded_by: null
owner: "<tech-lead-ou-equipe>"
date: YYYY-MM-DD
related_services: []
related_rules: []
---

# ADR-001: <Título da Decisão>

## Contexto
Qual problema técnico ou de negócio motivou esta decisão?

## Decisão
O que foi decidido de forma objetiva.

## Alternativas Rejeitadas
- **Alternativa A:** Motivo da rejeição.

## Consequências
- Impactos positivos, trade-offs e riscos conhecidos.
```

### C. Template de Agent Handoff (`08-agent-memory/handoffs/`)
```markdown
---
id: HANDOFF-YYYYMMDD-NNN
type: memory
project: "<project-id>"
task_id: "<TASK-ID>"
from_agent: "<agent-id>"
created_at: YYYY-MM-DDTHH:MM:SSZ
status: active
---

# Handoff: <Título da Tarefa>

## Estado Validado
- O que já foi implementado e testado (com caminhos de arquivos e commits).

## Próximos Passos
1. Passo pendente 1.

## Bloqueios, Riscos e Decisões Tomadas
- Pontos de atenção para o próximo agente não repetir descobertas.
```

---

## 3. Bootstrap Assistido (Evitando o "Cold Start")

Times dificilmente preenchem dezenas de arquivos Markdown/YAML manualmente no primeiro dia. Para eliminar esse atrito:
1. Ao rodar `brain init` (CLI) ou conectar um repositório no **Project Autodiscovery**, o sistema analisa estrutura de pastas, schemas/migrations de banco, testes existentes e os últimos 50–100 commits/PRs.
2. Gera automaticamente rascunhos iniciais (`status: draft`, `confidence < 1.0`) em `00-overview/`, `01-business/business-rules/` e `03-architecture/`.
3. A equipe revisa e ajusta propostas no Command Center, via PR ou por canal externo conectado com identidade e ação explícitas, em vez de escrever documentação do zero. Quando Git for a fonte autoritativa, a decisão de canal não substitui o merge do PR para publicar a versão oficial.

---

## 4. Vínculo Direto Código ↔ Regra (Evitando *Drift*)

Para impedir que código e documentação divirjam com o tempo, o sistema suporta **âncoras leves** diretamente no código-fonte e nos testes, além de mapeamentos no `.project-brain.json`:

- **Âncoras em comentários:** ex. `@brain-rule BR-SUB-014` ou `@brain-adr ADR-021` em funções, endpoints, classes ou suítes de teste.
- **Benefício no CI e nos Guardians:** quando um PR altera uma função marcada com `@brain-rule BR-SUB-014`, o **Business Rule Guardian** identifica imediatamente a regra e o teste vinculados (`subscription-cancel.spec.ts`), sem depender apenas de busca semântica aproximada.

---

## 5. Sincronização Git <-> Banco de Dados

1. Toda alteração em `.brain/` ou `data/knowledge/` via commit dispara o **Ingestion Worker** (`apps/worker`).
2. O worker valida o schema (YAML frontmatter / campos obrigatórios), calcula `content_hash`, atualiza `knowledge_items`, extrai arestas explícitas (`related`, `superseded_by` e âncoras `@brain-rule`/`@brain-adr` do código) para `knowledge_relations` e regenera apenas os embeddings alterados.
3. Arquivos inválidos geram alerta no pipeline de CI/ingestão sem corromper a versão anterior aprovada no banco.

---

## 6. Compatibilidade com Projetos Existentes (*Brownfield*), Monorepos e Schemas

Para não exigir que times quebrem ou reorganizem repositórios que já existem:
- **Modo Não-Invasivo (`knowledgePaths`):** O manifesto `.project-brain.json` permite mapear caminhos já existentes (`docs/`, `adr/`, `openapi.yaml`, `.cursor/rules`, `AGENTS.md`) para indexação imediata, sem precisar mover nada para `.brain/`.
- **Suporte a Monorepos (`subProjects`):** Um único `.project-brain.json` na raiz de um monorepo (Turborepo, Nx, pnpm workspaces) pode declarar `subProjects[]` mapeando cada pasta (ex.: `services/billing`, `services/auth`) para seu próprio `projectId`/`serviceId` no grafo.
- **Versionamento de Schema (`schemaVersion`):** Todo `.project-brain.json`, arquivo YAML de regra e banco SQLite local carrega `schemaVersion` explícito, com migrações automáticas via `brain migrate`.

