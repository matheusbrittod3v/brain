# Arquitetura de Segurança e Governança

Um *Second Brain* empresarial concentra código-fonte, regras comerciais, contratos e incidentes. Por isso, segurança e governança são requisitos estruturais desde a Fase 1 (`packages/auth`, `packages/rules-engine`, `tests/security/`).

---

## 1. Isolamento Multi-Tenant e Classificação de Dados

- **Isolamento Lógico Estrito:** Toda tabela e todo índice (inclusive `knowledge_embeddings` e `knowledge_relations`) exige `tenant_id` e `project_id` obrigatórios.
- **Níveis de Classificação (`accessPolicyId`):**
  - `public-org`: Padrões globais da organização.
  - `internal-project`: Conhecimento técnico e de produto do projeto.
  - `confidential-business`: Regras financeiras, contratos, margens e dados de clientes.
  - `restricted-security`: Incidentes críticos, vulnerabilidades, auditoria e compliance.

---

## 2. Controle de Acesso Pré-Recuperação (RBAC + ABAC)

**Princípio:** Um documento ou chunk vetorial não autorizado **nunca** deve ser retornado pelo banco e filtrado apenas na camada de aplicação.

1. O usuário ou agente autentica via **OIDC** (token JWT com `tenantId`, `actorId`, `roles` e `projectScopes`).
2. O `Policy Engine` resolve os `accessPolicyId` permitidos antes da consulta.
3. As queries SQL (FTS, busca vetorial exata inicial e grafo) executam sob RLS e também aplicam filtros explícitos de `tenant_id`, `project_id` e `access_policy_id`; para relações, ambos os projetos e as duas políticas de origem/destino precisam estar autorizados. Índices vetoriais aproximados só podem ser ativados após a validação de isolamento definida nas decisões normativas.
4. O cache LRU local ou Valkey opcional inclui o hash das políticas do ator na chave. Respostas em cache também passam por autorização; o cache nunca substitui RLS.

### Autenticação do Command Center e Visibilidade Cross-User

- **Login obrigatório no Painel:** O Command Center (`apps/web`) exige tela de login (Keycloak OIDC/SSO em hospedagem online; credencial local / `OfflineLease` no Edge offline), não expondo rotas ou dados sem sessão autenticada.
- **Escopo por usuário e setor:** Toda requisição do painel carrega `tenantId`, `actorId`, `roles`, `allowedProjects` e `allowedPolicies`. Em ambientes online multi-setor, cada usuário vê apenas os projetos, métricas e documentos do seu escopo.
- **Permissão para dados de outros usuários:** A leitura de handoffs, execuções do Brain Runner, propostas e `audit_logs` de outros usuários segue política explícita (`self` vs. `project/sector` vs. `org/audit`) validada pelo OPA e imposta por RLS no PostgreSQL (e refletida no `OfflineLease` no modo offline).

---

## 3. Exclusão de Segredos e Sanitização na Ingestão

Antes de persistir qualquer arquivo ou chunk no `Ingestion Worker` (`packages/ingestion`):
- **Scanner de Segredos:** Bloqueia ou mascara chaves de API, tokens JWT, senhas, chaves privadas PEM, strings de conexão e arquivos `.env`.
- **Detecção de PII:** Aplica mascaramento configurável em dados pessoais vindos de CRM, tickets ou logs de suporte antes da indexação vetorial.

---

## 4. Proteção contra Prompt Injection Indireto

Documentos externos (issues, comentários de PR, e-mails de clientes, páginas web) podem conter instruções maliciosas tentando sequestrar o comportamento de agentes de IA.

Mitigações obrigatórias:
1. **Separação de Dados e Instruções (Defense-in-Depth):** No `Context Pack`, conteúdos vindos de fontes externas recebem `<external_data trust="untrusted">` e instrução de sistema proibindo execução de comandos derivados desse bloco. Além disso, o **Policy Engine** bloqueia qualquer ação de escrita/delegação disparada na mesma janela se não houver intenção explícita autorizada pelo usuário, e a suíte `tests/security/` valida cenários adversariais de injeção.
2. **Proibição de Auto-Promoção:** Documentos ingeridos nunca alteram `agent-instructions/` ou regras oficiais (`approved`) sem revisão humana.
3. **Sanitização:** Remoção de diretivas suspeitas e sinalização em `warnings` quando fontes externas de baixa confiança forem incluídas.

---

## 5. Auditoria, Proveniência e Conformidade LGPD

- **Trilha de Auditoria (`audit_logs`):** Registra leituras sensíveis, buscas, criações, alterações, aprovações e revogações com `actorId`, `actorType` (`human` | `agent` | `system`) e timestamp.
- **Versionamento e Revogação:** Toda regra ou decisão mantém histórico de versões (`sourceVersion`, `SUPERSEDES`). Conhecimento incorreto pode ser revogado (`deprecated`/`superseded`) com invalidação imediata de cache e embeddings.
- **LGPD (exclusão parcial implementada):** `POST /v1/privacy/erase` exige PostgreSQL e conexão `brain_system`; numa transação, apaga itens do projeto por `owner_id` ou tag, suas versões, embeddings e relações, e grava tombstones em `sync_changes`. A resposta informa as contagens e `complete: false`. MinIO/backups seguem fora da exclusão; dados operacionais legados sem `actor_id`, históricos de aprovação e eventos de integração sem vínculo de ator não são processados; memórias, handoffs, tarefas, preferências de notificação e notificações pendentes atuais vinculadas a `actor_id` são apagados, incluindo perguntas e leases de tarefas removidas; cópias Edge só removem o item ao consumir o tombstone no próximo sync. Crypto-shredding e anonimização histórica de auditoria ainda não estão implementados; não tratar a rota como exclusão completa.
- **Revisão Humana Obrigatória:** Alterações em domínios críticos (`01 Identidade`, `02 Regras de Negócio`, `03 Arquitetura`, `07 Decisões`, `11 Segurança`) exigem aprovação humana explícita via PR no Git, workflow do Dashboard ou canal externo conectado. Canais externos são interfaces; identidade, autorização, versão e decisão são validadas e registradas pelo Noema conforme [decisões normativas 86–87](../00-normative-decisions.md).

### Aprovação e conversa por canais externos

- A decisão precisa estar vinculada a uma identidade humana autenticada e autorizada no momento da resposta. Nome de exibição, endereço de e-mail informado no corpo ou texto citado não bastam para conceder permissão.
- Aprovações e rejeições usam ação estruturada do canal ou link para uma página autenticada. Mensagens livres servem apenas como esclarecimentos; não alteram `status = 'approved'`.
- Callback de decisão exige HMAC e bearer, mapeia o identificador estável do usuário do provedor para ator humano/tenant/papéis/projetos/políticas configurados, e valida projeto, proposta e versão. Usa `externalEventId` persistido com RLS para impedir replay e duplicidade; falha de validação resulta em rejeição.
- O payload enviado ao canal contém o mínimo necessário. Conteúdo restrito, diffs completos e evidências são carregados do Noema depois de autorização.
- Texto recebido do canal é conteúdo externo não confiável e não pode mudar políticas, ampliar escopo do agente ou instruir execução de ações fora da tarefa.
- Timeout, indisponibilidade do canal e ausência de resposta nunca equivalem a aprovação. Podem resultar em lembrete, escalonamento ou expiração sem decisão.
- A pessoa que propôs não pode aprovar a própria proposta quando a política exigir segregação de funções; agentes e service accounts nunca são aprovadores humanos.

---

## 6. Guardrails em 3 Camadas (Ingestão, Execução e Saída)

1. **Guardrails de Ingestão:** `Gitleaks` + `Presidio` bloqueiam segredos e PII antes do índice; documentos externos recebem `trustLevel: "untrusted"`.
2. **Guardrails de Execução (Agentes & Brain Runner):**
   - *Command Denylist/Allowlist:* bloqueio de comandos destrutivos (`rm -rf`, `DROP TABLE`, `git push --force`) em sessões autônomas.
   - Limites rígidos de `max_steps`, `token_budget` e `timeout` por tarefa, além de modo `draft-only` para subagentes em background.
3. **Guardrails de Saída & Mudança:** `Architecture Guardian`, `Business Rule Guardian`, *Confidence Gate* (inferências marcadas como `is_inferred = true`) e aprovação humana obrigatória para domínios críticos.

---

## 7. Gestão Segura de `.env` e Variáveis de Ambiente

- **Proibição de Valores Reais:** Arquivos `.env`, `.env.local` e segredos de runtime **nunca** são indexados, embeddados ou incluídos em `Agent Handoffs`.
- **Indexação de Contrato (`.env.example`):** O Brain indexa apenas o **schema das variáveis** (nome, obrigatoriedade, descrição e serviço que consome).
- **Validação Automática (`brain env check` / `brain doctor`):** Ao trocar de máquina/IDE ou iniciar um projeto, a CLI verifica localmente se todas as variáveis exigidas pelo `.env.example` estão presentes no ambiente destino, sem expor seus valores.

---

## 8. Segurança no Modo Offline (Local Edge Sync)

> **Estado de implementação:** O CLI abre o banco Edge com `requireSqlCipher`, usando `better-sqlite3-multiple-ciphers` no perfil SQLCipher legado 4, e guarda uma chave aleatória no keychain do sistema. Smoke test local de `brain sync status` em macOS arm64 confirmou que o arquivo criado não tem cabeçalho SQLite; testes do pacote verificam inserção, chave incorreta, reabertura e rebuild cifrado. A matriz de CI Windows/Linux/macOS foi adicionada, mas ainda não teve execução observada neste ambiente. Consumidores da API `EdgeDatabase` devem exigir explicitamente `requireSqlCipher`; `PRAGMA key` sozinho não é proteção.

Quando o funcionário utiliza o **Local Edge Brain** offline ([hybrid-edge-sync.md](../01-architecture/hybrid-edge-sync.md)):
1. **Snapshot Filtrado por Cargo/Setor (`pull`):** O servidor aplica o OPA antes de empacotar qualquer delta para o SQLite local; dados fora do escopo do cargo nunca chegam ao disco do colaborador.
2. **Expiração & Revogação Remota (*Policy Revocation*):** O *offline lease* dura **24h (máximo 7 dias)** e o refresh token no keychain exige conexão online com o Keycloak/Hub para renovar (nunca renova offline). Expirado o prazo, o SQLCipher bloqueia o banco local; ao reconectar, o próximo `brain sync pull` remove automaticamente todos os itens revogados.
3. **Ingestion Gate no `push`:** Nenhum rascunho offline sobe para o Hub central sem passar por `Gitleaks` + `Presidio` e sem respeitar o fluxo de aprovação (`draft` / `brain_change_propose`) correspondente ao cargo do autor.
4. **Paridade de Login e Permissões no Painel Offline (`brain ui`):** O dashboard local exige `OfflineLease` válido ou credencial local do usuário e aplica as mesmas restrições de `tenantId`, `actorId`, `allowedProjects` e `allowedPolicies` sobre o snapshot local, refletindo o escopo de visibilidade do usuário mesmo sem conexão.

