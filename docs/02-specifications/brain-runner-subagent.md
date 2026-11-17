# Brain Runner — Subagente Leve em Background, Fila e Agendamento

O **Brain Runner (`apps/agent-runner`)** é um serviço leve de execução assíncrona criado para tirar tarefas rotineiras, repetitivas ou agendadas das costas do agente principal da IDE (**Antigravity, Codex, Kiro, Cursor, Claude Code**).

Enquanto o agente principal foca em raciocínio complexo, arquitetura e edição de código, o **Brain Runner** atua como subagente conectado ao **Project Brain OS 2.0**, rodando localmente ou na nuvem conforme o perfil. Atualmente o executor disponível é Ollama local. Adaptadores para provedores remotos, modo híbrido e Apple Foundation Models continuam planejados e não são anunciados como prontos pela CLI.

---

## 1. Comando Único: `brain runner up`

O fluxo local usa fila Edge persistente e inicia um daemon em primeiro plano. Não instala Ollama nem baixa modelos sem configuração explícita:

```bash
# Modo local (Ollama opcional; recursos verificados antes de usar modelo)
brain runner up --local

# Seleciona explicitamente o executor Ollama local
brain runner up --provider ollama

# Enfileirar e consultar tarefas localmente sem Hub
brain task enqueue --local "Resuma os riscos deste projeto"
brain task list --local
```

O daemon permanece ativo até `Ctrl-C` ou sinal `SIGTERM`; ao encerrar, para o polling e fecha o banco. A listagem local inclui estado, draft de resultado e uso reportado pelo modelo. Provedores não implementados e `--hybrid` falham com mensagem explícita.

### O que o `brain runner up --local` faz
1. **Detecta o perfil por RAM:** até 8 GB seleciona `qwen2.5-coder:1.5b`; acima disso seleciona `qwen2.5-coder:3b`.
2. **Verifica Ollama:** consulta o endpoint local configurado. Ollama não é instalado nem baixa modelos automaticamente; `--pull` é necessário para baixar o perfil ausente.
3. **Modelo selecionado:** o mesmo perfil verificado na inicialização é usado pelo executor.
   - **Perfil Lite (4–8 GB RAM):** usa modelo compacto 1.5B–3B sob demanda e prioriza SQLite FTS5 para evitar *swap* de memória.
   - **Perfil Standard (16+ GB RAM / GPU):** usa `bge-m3` + `FlashRank` + modelo 3B–7B (`qwen2.5-coder:3b`, `llama3.2:3b`, `gemma3:4b`).
4. **Executa em draft-only:** envia a instrução da tarefa ao Ollama e persiste resposta, estado e métricas de tokens/duração na fila Edge. Não altera arquivos nem executa comandos.
5. **Fila local:** `brain task enqueue --local` grava no Edge cifrado; `brain runner up --local` reivindica tarefas; `brain task list --local` permite acompanhar fila e resultado. O Runner local não depende do Hub.

---

## 2. Base Open-Source para Modificar e Tornar Nativo

Como o **Brain Runner** é focado em **subagente de tarefas** (e não em um assistente pessoal de WhatsApp/Telegram), vale adotar uma base open-source pequena e enxuta em TypeScript que possa ser **baixada, limpa e modificada** para parecer 100% nativa do `apps/agent-runner`:

| Opção Open-Source | Tamanho / Perfil | Quando Escolher |
| :--- | :--- | :--- |
| **Micro-runner TS + MCP + Ollama** *(ex.: `ai-action/code-ollama`, `ausboss/mcp-ollama-agent`, `phuoctrung-ppt/coding-agent` ou loop com **Vercel AI SDK** + `@modelcontextprotocol/sdk`)* | **Muito pequeno** (centenas a poucos milhares de linhas em TypeScript) | **Padrão recomendado:** código minúsculo, fácil de entender em minutos, sem peso de canais de chat pessoal; já traz loop agêntico + tool calling + Ollama + MCP Client prontos para adaptar |
| **NanoClaw** (`nanocoai/nanoclaw`) | **Compacto** (~30k linhas em TypeScript) | Quando precisar de **isolamento por container** (Docker/Apple containers) por sessão de subagente e suporte multi-canal já estruturado |

---

## 3. Como os Agentes Principais Delegam Tarefas

Agentes no **Antigravity, Codex, Kiro, Cursor ou Claude Code** podem enfileirar tarefas no Hub via ferramenta MCP **`brain_delegate_task`** ou API REST (`/v1/projects/:projectId/runner/tasks`), ou no Edge local via CLI (`brain task enqueue --local`). No Hub, `cron` cria uma agenda UTC no pg-boss; o worker converte cada disparo em tarefa durável. Agendas podem ser consultadas e canceladas em `/v1/projects/:projectId/runner/schedules`. O cron local no Edge ainda está pendente.

- **Tarefas sob demanda (Delegação):**
  - Resumir últimos commits/PRs e gerar rascunho de release notes.
  - Pré-processar arquivos no *Project Autodiscovery* e sugerir rascunhos de `BusinessRule` em `.brain/`.
  - Rodar checagens rápidas de *Knowledge Health* após alterações.
  - Consolidar memórias episódicas e formatar resumos de *Agent Handoff*.
- **Tarefas agendadas (Cron / Schedules):**
  - **Pós-sessão / Pós-merge:** calcular *Context Hit Rate* e atualizar `CO_ACCESSED_WITH`.
  - **Diário (ex.: 23h):** varrer PRs fechados no dia e abrir sugestões em lote de *Living Documentation*.
  - **Semanal (ex.: Segunda 08h):** gerar resumo executivo de riscos, regras sem testes e bloqueios para CTO/QA.

### Perguntas e retomada humana
Quando a execução depende de uma decisão contextual, o Runner pode registrar uma pergunta vinculada ao `taskId` em `POST /v1/projects/:projectId/runner/tasks/:taskId/questions`. A tarefa passa para `awaiting_human` até alguém autenticado responder com `questionId` e `idempotencyKey` em `/responses`. A resposta não aprova proposta nem encerra a tarefa: ela é persistida, a tarefa volta para `queued` e o worker acrescenta a pergunta e a resposta à instrução ao reivindicá-la. Só pode haver uma pergunta pendente por tarefa; reenvio idêntico é idempotente.

---

## 4. Local vs. Nuvem

| Aspecto | Modo Local (Máquina do Usuário) | Modo Nuvem (Cluster da Empresa) |
| :--- | :--- | :--- |
| **Fila & Cron** | Tabela SQLite durável em `packages/database-edge`; polling pelo daemon `brain runner up --local`; cron ainda pendente | `pg-boss` sobre PostgreSQL com consumidores descobertos pelo worker; disparos viram tarefas em `runner_tasks`; Temporal.io opcional para workflows longos |
| **Modelo de IA** | Ollama local, selecionado via preflight; outros adaptadores ainda pendentes | Adaptadores remotos/cloud ainda pendentes para o Runner |
| **Escopo** | Tarefas locais com saída draft-only persistida no Edge | Tarefas do Hub e crons via pg-boss; criação de PRs pelo Runner permanece em integração |
| **Custo** | Sem cobrança de serviço externo; usa hardware local | Infraestrutura própria e orçamento por time/setor |

---

## 5. Guardrails Obrigatórios, FinOps e Roteamento de Modelos

Como o **Brain Runner** utiliza modelos menores e roda de forma autônoma em background:
1. **Draft-Only:** O executor local envia apenas a instrução ao Ollama e persiste o resultado como `[bot-draft]`; não altera arquivos nem executa comandos. O Runner Hub envia payloads draft/PR para `apps/api`, que pode abrir PRs `[bot-draft]` pela GitHub/GitLab App.
2. **Permissão Herdada (OPA):** Executa estritamente dentro do `tenantId`, `projectId` e `accessPolicyId` do usuário ou *service account* que enfileirou a tarefa.
3. **Orçamento, Identificação do Modelo e Timeout:** Todo job possui `max_steps`, `token_budget` e `timeout` curtos. Modelos Ollama são fixados em `models.lock.json` (tag + digest SHA-256 + licença verificada por release). Para Apple `fm`, registrar o identificador de modelo informado pelo serviço e a versão do macOS; o artefato do modelo de sistema é gerenciado pela Apple e não é pinado nem baixado pelo Noema.
4. **Falhas e escalonamento:** Falha de execução marca a tarefa `failed` e não bloqueia a fila. Instruções destrutivas são interceptadas antes de chamar o modelo e ficam `escalated` para retomada pelo agente principal (Antigravity/Codex/Kiro).
5. **FinOps de IA (estado parcial):** O worker registra atomicamente o consumo diário de tokens do Context Pack em PostgreSQL por tenant/projeto (dia UTC), com limite configurável em `NOEMA_RUNNER_DAILY_TOKEN_LIMIT` (padrão 100.000); ao exceder, registra o consumo e escala a tarefa. Cotas por departamento aguardam o vínculo departamento/projeto no modelo de identidade; downgrade automático não está implementado. Com `NOEMA_RUNNER_MODEL_EXECUTION=ollama`, o worker usa Ollama opt-in e persiste por tarefa `prompt_eval_count`, `eval_count` e duração retornados pelo provedor; cobrança de API local é USD 0. Custo de hardware/energia e telemetria de provedores externos permanecem indisponíveis.
6. **Model Routing Matrix:**
   - *Triagem, tags e resumos curtos* → modelo local **1.5B–3B** (ultrarrápido, custo zero).
   - *Extração de regras YAML / JSON estrito* → modelo **7B+** com *Structured Outputs* (JSON Schema forçado).
   - *Arquitetura complexa e refatoração* → escalonado para o agente principal da IDE (Antigravity, Codex, Kiro).

### Provedor Apple Foundation Models (`fm`) — planejado

- O `fm` é uma opção de inferência local para o Brain Runner em Macs cujo sistema ofereça o CLI e cujo comando `fm available` confirme que o modelo de sistema está pronto. Compatibilidade nominal do hardware/macOS não substitui essa verificação em tempo de execução.
- O Runner pode usar `fm serve` como endpoint local Chat Completions (`/health`, `/v1/models`, `/v1/chat/completions`) por meio de um adaptador de provedor. A execução do servidor é responsabilidade do adaptador/CLI do Noema; se o CLI da Apple exigir aceitação de termos, o usuário deve fazê-la diretamente, sem o Noema aceitar em seu nome.
- A seleção de `apple-fm` é explícita. Não usar Apple Foundation Models como fallback implícito, não enviar prompts a PCC/nuvem e não redirecionar para provedores remotos sem escolha explícita. Exibir quando a execução é local e quais metadados de modelo/macOS estão disponíveis.
- Manter os mesmos limites do Runner para todos os provedores: sandbox, ferramentas permitidas, escopo de projeto, `draft-only`, limites de passos/tokens/tempo, auditoria e aprovação humana. Disponibilidade do modelo não concede permissões adicionais.
- Antes de declarar o provedor equivalente ao Ollama/Qwen para tarefas agênticas, validar em avaliação compatível: chamadas de ferramentas MCP, streaming, cancelamento/timeouts, saída estruturada, limite de contexto e comportamento de falha. Até essa validação, declarar suporte como **provedor experimental para tarefas compatíveis**, não como substituto universal.

