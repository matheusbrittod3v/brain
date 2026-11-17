# Capacidades 2.0, Project Command Center e Visão de Futuro

Este documento especifica as **10 novas capacidades** introduzidas no **Project Brain OS 2.0**, o painel **Project Command Center** e os módulos planejados para versões futuras.

---

## 1. As 10 Novas Capacidades da Plataforma

| # | Capacidade | Módulo | Descrição e Comportamento |
| :--- | :--- | :--- | :--- |
| **01** | **Universal Agent Handoff** | `packages/agent-handoff` | Transfere tarefas entre IDEs/agentes (ex.: Antigravity -> Codex -> Kiro) preservando objetivo, branch, commit base, arquivos modificados, testes executados, decisões e próximos passos. |
| **02** | **Project Autodiscovery** | `packages/project-discovery` | Ao conectar um repositório, analisa estrutura, linguagens, frameworks, endpoints, modelos de dados, dependências, testes e infra. Gera um mapa inicial no domínio 03/05 com **níveis de confiança** explícitos (`confidence < 1.0` até revisão). |
| **03** | **Architecture Guardian** | `packages/architecture-guardian` | Analisa alterações de código e PRs em busca de violações arquiteturais, dependências proibidas entre camadas, desvios de ADRs e padrões obrigatórios. Pode atuar como *check* automatizado no CI. |
| **04** | **Business Rule Guardian** | `packages/business-rule-guardian` | Relaciona alterações técnicas (ex.: endpoints, cálculos, máquinas de estado) às regras comerciais em `01-business/business-rules/`. Identifica violações ou riscos potenciais e solicita revisão humana quando necessário. |
| **05** | **Cross-Project Intelligence** | `packages/impact-analysis` | Identifica bibliotecas compartilhadas, APIs consumidas por múltiplos sistemas, decisões reutilizáveis e impactos de mudanças entre repositórios da mesma organização. |
| **06** | **Autonomous Task Planner** | `packages/task-engine` | Transforma requisitos em propostas estruturadas de épicos, histórias, tarefas, dependências, testes sugeridos e critérios de aceite. Toda execução ou criação definitiva permanece condicionada às permissões e aprovação definidas. |
| **07** | **Temporal Knowledge Engine** | `packages/temporal-knowledge` | Permite consultar como a arquitetura, uma regra de negócio ou uma funcionalidade operava em determinado commit, tag ou período histórico (`validFrom` / `validUntil`), distinguindo claramente o estado atual do passado. |
| **08** | **Knowledge Health Monitor** | `packages/knowledge-health` | Detecta continuamente documentos desatualizados, regras ou ADRs contraditórias, tarefas sem critérios de aceite, regras críticas sem testes vinculados e itens sem fontes verificáveis. |
| **09** | **Token & Cost Optimizer** | `packages/context-optimizer` | Monta `Context Packs` por relevância, orçamento de tokens e tipo de tarefa. Reutiliza resumos hierárquicos e resultados indexados em cache para reduzir latência e custo de LLM. |
| **10** | **Living Documentation** | `packages/workflow-orchestrator` | Sugere atualizações de documentação após merges, mudanças de código, novas decisões ou entregas. Mantém sugestões em estado de rascunho/PR, separadas do conhecimento oficial aprovado. |

---

## 2. Dashboard: Project Command Center (`apps/web`)

O **Project Command Center** é a interface web central (Next.js) para engenheiros, Product Owners e gestores acompanharem a saúde do conhecimento, o trabalho dos agentes e as aprovações pendentes.

> **Estado e escopo:** O `apps/web` apresenta as dez áreas do menu, com cobertura variável. A Caixa de Entrada mostra evidências, prazo e preferências pessoais; Projetos inicia ingestão GitHub e acompanha jobs; Integrações mostra estado de configuração, escopos, notificações, sincronizações recentes e permite enfileirar sync SaaS via Nango quando disponível. Operação resume saúde/QA, filas e falhas recentes, estima tokens indexados e agrega contadores/duração Ollama persistidos nas tarefas quando a execução `NOEMA_RUNNER_MODEL_EXECUTION=ollama` está habilitada. Cobrança de API local é zero; custo de infraestrutura, latência e provedores externos não estão medidos. Outras áreas ainda expõem respostas JSON ou instruções em vez de fluxos completos. O acesso exige conexão explícita por chave local/Bearer ou OIDC Authorization Code + PKCE configurado; nenhuma chave padrão vem no cliente, o painel fica bloqueado antes da autenticação e tokens OIDC permanecem em memória com renovação pelo refresh token. A API cria lembrete antes do prazo e escalonamento no vencimento via pg-boss; ambos são persistidos como eventos visíveis em `GET /v1/projects/:projectId/approval-reminders`. A expiração nunca decide a proposta. Ações interativas Slack estão implementadas e exigem configuração do app; cartões de Teams, Jira, ClickUp e e-mail seguem pendentes, conforme [connector-framework-and-integrations.md](connector-framework-and-integrations.md).

### Autenticação, Escopo por Usuário/Tenant e Visibilidade Entre Setores

Quando hospedado online para múltiplos times e setores — bem como no modo local/offline (`brain ui`) — o **Project Command Center** opera estritamente por **usuário e tenant**:

- **Painel de Login obrigatório (sem acesso direto exposto):** O dashboard nunca deve ficar exposto sem autenticação. Ao acessar o painel sem sessão válida, o usuário é direcionado para a tela de login:
  - **Modo Online / Corporativo:** autenticação via **Keycloak OIDC/SSO** (ou provedor OIDC configurado), com sessão renovável, logout explícito e proibição de embutir chaves de API padrão no código-fonte cliente.
  - **Modo Local / Offline (`brain ui`):** exige autenticação local explícita ou `OfflineLease` válido e não expirado vinculado ao `actorId` e `tenantId`; após expiração do lease, o painel bloqueia a leitura até reconexão ao Hub.
- **Dashboard personalizado por usuário, tenant e setor:** Após o login, a interface e todas as consultas à API são filtradas pelo contexto autenticado (`tenantId`, `actorId`, `roles`, `allowedProjects`, `allowedPolicies`). Usuários de setores distintos (ex.: Engenharia, Pagamentos, Comercial, QA, AppSec) visualizam apenas os projetos, espaços de trabalho, métricas e documentos autorizados para seu perfil.
- **Permissões granulares para ver dados de outros usuários:** O acesso a dados produzidos por outros usuários (tarefas do Brain Runner, Agent Handoffs, propostas em revisão, feedbacks e trilhas de auditoria) é governado por **RBAC/ABAC + OPA + RLS** no servidor:
  - *Nível próprio (`self`):* visualiza e gerencia apenas os próprios rascunhos, execuções, handoffs e itens atribuídos.
  - *Nível de projeto/setor (`project` / `team`):* revisores, Tech Leads e POs autorizados visualizam propostas, handoffs e execuções dos projetos/setores permitidos.
  - *Nível organizacional/auditoria (`org` / `audit`):* apenas papéis privilegiados (`admin`, `appsec`, `cto`) visualizam `audit_logs` globais, gestão de acessos e indicadores consolidados de todo o tenant.
- **Paridade no modo Offline (Local Edge):** O `brain ui` offline reflete exatamente as permissões do usuário autenticado contidas no `OfflineLease` e no snapshot filtrado do Edge DB, garantindo que dados de outros tenants ou setores não autorizados nunca apareçam na interface local.

### Espaços de Trabalho Planejados

| Espaço | Conteúdo e ações principais | Usuários principais |
| :--- | :--- | :--- |
| **Minha Caixa de Entrada** | Aprovações, perguntas que aguardam resposta, conflitos e alertas acionáveis, vindos do painel ou de canais conectados. Exibe responsável, prazo, origem, evidências e ações disponíveis. | Todos os revisores e operadores |
| **Projetos** | Resumo de fontes conectadas, estado e horário da última ingestão, saúde da documentação e tarefas recentes; inclui onboarding guiado e próximos passos de configuração. | Devs, Tech Leads, gestores |
| **Agentes e Execuções** | Histórico de execuções, objetivo, arquivos/fontes consultados, ferramentas chamadas, resultado, custo e estado de espera humana; permite pausar, cancelar e retomar quando suportado pelo executor. | Devs, operadores, AppSec |
| **Conhecimento** | Regras, ADRs, documentos e relações com código, contratos e testes; mostra origem, responsável, versão e data de sincronização, com comparação de versões. | Devs, Produto, QA, AppSec |
| **Busca e Contexto** | Consulta em linguagem natural, fontes recuperadas e explicação de por que cada fonte entrou no Context Pack; coleta avaliação útil/incompleta/incorreta. | Devs, agentes e especialistas |
| **Integrações** | Conexões Git, planejamento, documentação e comunicação; mostra escopos autorizados, última sincronização, falhas e necessidade de reconectar. | Administradores e operadores |
| **Impacto de Mudanças** | Serviços, APIs, regras, equipes e testes possivelmente afetados por uma alteração, com evidências e links para as fontes. | Tech Leads, QA, SRE, AppSec |
| **Operação** | Saúde/QA do projeto e filas com falhas recentes em janela de 24h; estimativa de tokens indexados separada de uso Ollama medido por tarefa (quando opt-in ativo). Cobrança API local é zero; telemetria de latência, custo de infraestrutura/energia, provedores externos, responsáveis e remediação acionável seguem pendentes. | Operadores, SRE, administradores |
| **Acesso e Políticas** | Mostra os escopos efetivos do próprio ator (`GET /v1/projects/:projectId/access/profile`) e consulta a trilha de auditoria filtrada por projeto, ator, ação, alvo e política; auditoria restrita a admin/AppSec/Tech Lead. Gestão de membros/papéis, catálogo e edição de políticas, concessões temporárias e lista de revisores autorizados ainda dependem da integração administrativa do provedor de identidade e de um registro de políticas administrável. | Administradores e AppSec |
| **Modelos e Padrões** | Questionário do Command Center gera comando para scaffold local com stack, domínio, criticidade, PII, pagamentos e estilo de comunicação. Também consulta ADRs aprovadas, internas, verificadas e não inferidas do projeto atual, exibindo fonte e versão. CLI cria manifesto, estrutura `.brain/`, regra/ADR draft e guia de segurança; projetos sensíveis recebem `restricted-security` e guardians iniciam `advisory`. Recomendação cross-project, aplicação automática de ADR ao starter, publicação/registro central e pipeline CI gerado seguem pendentes; revisão humana é obrigatória. | Arquitetura, Tech Leads, Devs |

O endpoint `GET /v1/projects/:projectId/scaffold/recommendations?domain=...&stack=...` limita sugestões a precedentes internos aprovados e verificados do projeto autorizado; não cria recomendação quando não há correspondência. O comando gerado usa `noema scaffold <nome> --objective <texto> --domain <domínio> --criticality low|medium|high|critical --stack node-ts|python --communication sync|events [--pii] [--payments]`. O CLI cria a pasta no diretório atual. Respostas alimentam os artefatos iniciais, mas não publicam um repositório nem tratam a revisão humana como aprovação.

### Facilidades Transversais

- **Aprovação multicanal:** notificar e coletar decisão explícita por Slack, Teams, Jira, ClickUp ou e-mail quando o conector correspondente estiver configurado. O Noema continua sendo o registro autoritativo da decisão.
- **Atribuição e delegação:** revisores autorizados podem atribuir ou reatribuir uma revisão; enquanto atribuída, só o responsável decide. Cada solicitação tem prazo configurável por `NOEMA_APPROVAL_SLA_HOURS` (padrão 72h), lembrete configurável por `NOEMA_APPROVAL_REMINDER_LEAD_HOURS` (padrão 24h antes) e evento de escalonamento ao vencer. Revisão reenviada recebe novo prazo; decisão continua explícita e humana.
- **Resumo para revisão:** mostrar diff, origem, evidências, impacto, riscos e motivo da sugestão antes de aprovar, rejeitar ou pedir alterações. A Caixa de Entrada mostra diff de texto entre versões, cobertura QA do projeto, impactos do grafo, risco calculado (`low` a `critical`) e linha do tempo de criação, atribuição, decisão, revisão e callbacks; `relatedIds` liga a proposta às regras impactadas. O autor pode editar e reenviar uma proposta com alterações solicitadas pelo workspace Conhecimento.
- **Feedback da busca:** registrar avaliação humana para medir qualidade e ajustar retrieval; feedback não promove conteúdo para conhecimento oficial.
- **Onboarding acionável:** depois de conectar um repositório, mostrar o que foi detectado, o que está pronto e o que requer configuração ou revisão.
- **Ações em lote limitadas:** permitir classificação e correção de metadados em lote; aprovações de domínios críticos continuam individuais.
- **Notificações configuráveis:** cada pessoa autenticada pode escolher canais, frequência (imediata, diária às 09:00 UTC ou semanal às segundas às 09:00 UTC) e categorias (aprovações e perguntas do Runner). Preferências são isoladas por tenant, projeto e ator; digest diário/semanal exige webhook configurado no servidor. A chave local compartilhada representa o único ator `local-dev`; OIDC usa `sub` para separar pessoas. Desativar avisos externos não remove itens da Caixa de Entrada.
- **Histórico comparável:** apresentar versões anterior e proposta, autoria, data, justificativa e decisão associada.

**Princípio de interação:** ações de alto impacto devem ter autor, escopo, confirmação explícita e trilha de auditoria. O painel e os canais conectados são interfaces para a mesma ação de domínio; não devem manter estados de aprovação independentes.

### Visões Principais

1. **Visão Geral (Overview):**
   - Indicadores consolidados: *Projetos conectados*, *Agentes registrados*, *Itens de conhecimento ativos* e *Alertas para revisão*.
   - Feed de atividades recentes com triagem acionável, por exemplo:
     - *Pull request analisado* -> Impacto potencial em 3 regras de negócio.
     - *Documentação revisada* -> Proposta de atualização de uma ADR.
     - *Conflito identificado* -> Duas regras de cobrança divergentes.
2. **Aba Agentes (Agent Continuity):**
   - Sessões ativas e histórico de handoffs entre Antigravity, Codex, Kiro, Cursor e Claude Code.
   - Visualização de qual agente alterou qual branch e quais testes foram validados.
3. **Aba Conhecimento & Governança:**
   - Navegador visual do Knowledge Graph (negócio <-> arquitetura <-> código <-> testes <-> contratos entre microsserviços).
   - Fila de aprovação humana (`packages/approval-engine`) para propostas geradas por *Living Documentation*, *Autodiscovery* ou `brain_change_propose`.
   - Painel de *Knowledge Health* (lacunas, conflitos e itens obsoletos).
4. **Visões Especializadas por Papel (CTO, DevOps, QA e AppSec):**
   - **CTO / Diretoria:** Tech Radar corporativo (desvios de stack sem ADR), risco/dívida técnica por projeto e custo/economia de IA por time.
   - **DevOps / SRE:** *Topology & Blast Radius Map* (Terraform/K8s/bancos/filas), *Incident-to-Code Memory* e *Pre-Deploy Readiness Check*.
   - **QA:** *Business-Rule-to-Test Coverage Matrix* e seleção de impacto de regressão E2E entre serviços.
   - **AppSec / Segurança:** *Threat Model Vivo*, endpoints com PII/LGPD, políticas OPA/Semgrep e rastreamento de CVEs/SBOM entre repositórios.
   - *(Detalhes completos em [enterprise-roles-and-microservices.md](enterprise-roles-and-microservices.md)).*

---

## 3. Visão de Futuro (Módulos Pós-2.0)

Após a consolidação dos módulos essenciais e da segunda fase, a plataforma prevê 8 evoluções avançadas:

1. **Project Simulator:** Simular o impacto técnico e comercial de uma mudança antes de aprová-la.
2. **Decision Intelligence:** Comparar alternativas arquiteturais usando restrições atuais e histórico de decisões anteriores.
3. **AI Product Analyst:** Transformar feedbacks de clientes, tickets de suporte e métricas em propostas estruturadas de requisitos.
4. **Dependency Radar:** Alertar proativamente sobre mudanças relevantes em bibliotecas, APIs e serviços compartilhados entre times.
5. **Autonomous Documentation Review:** Verificar continuamente a coerência semântica entre documentação aprovada, código em produção e regras de negócio.
6. **Multi-Agent Review Board:** Permitir que agentes especializados (Segurança, Arquitetura, Produto) revisem uma proposta em paralelo, mantendo a decisão final com responsáveis humanos autorizados.
7. **Project Time Machine:** Explorar visualmente o estado completo do conhecimento, grafo e arquitetura em versões ou marcos anteriores.
8. **Organization Knowledge Marketplace:** Compartilhar templates, padrões de arquitetura, playbooks e conhecimento aprovado entre projetos da organização.

