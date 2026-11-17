# Blocos Open-Source, Bibliotecas e Reuso de Projetos

> **Princípio Open-Source First:** O **Project Brain OS 2.0** deve permitir implantação self-hosted sem dependência obrigatória de APIs pagas. Serviços pagos (como OpenAI, Anthropic, Gemini API ou plataformas cloud) são provedores opcionais compatíveis; infraestrutura própria ainda tem custo operacional.

Para não construir tudo do zero nem inflar a infraestrutura com dezenas de serviços pesados, adotamos **três estratégias de reuso**:
1. **Bibliotecas embutidas (`npm` / `PyPI`)** — rodam dentro dos nossos processos (`apps/api`, `apps/worker`, `apps/cli`), sem exigir containers extras.
2. **Projetos JS/TS ou Python simples para adaptar/forkar** — reaproveitamos a base madura ajustando para os nossos contratos.
3. **Infraestrutura Open-Source consolidada** — apenas quando o ganho de performance e confiabilidade justifica o container.

---

## 1. Bibliotecas Embutidas Diretamente no Monorepo (Zero Infra Extra)

Esta seção é o catálogo de dependências e blocos reutilizáveis. **“Em uso”** significa declarado e efetivamente chamado pelo código; **“Recomendada”** é uma proposta, não uma dependência instalada ou requisito de runtime; **“Avaliar”** exige uma prova técnica antes de selecionar uma implementação; **“Opcional”** só se aplica quando a condição indicada ocorrer. Uma recomendação só passa a “Em uso” depois da alteração de código e dos manifestos/lockfile. A arquitetura-alvo descrita em outros documentos não prova que uma função já esteja implementada.

### Ecossistema TypeScript / Node.js (`apps/api`, `apps/mcp-server`, `apps/cli`, `apps/worker`)
| Biblioteca | Estado no código | Onde / decisão |
| :--- | :--- | :--- |
| `@modelcontextprotocol/sdk` | **Em uso** | `apps/api` hospeda MCP remoto; `apps/mcp-server` fornece o adaptador local `stdio`. |
| `fastify` + `@sinclair/typebox` | **Em uso** | `apps/api`; Fastify executa as rotas e TypeBox define schemas JSON. A inferência dos tipos nos handlers ainda pode ser melhorada com `@fastify/type-provider-typebox` (**recomendado**). |
| `zod` | **Em uso** | Validação de schemas MCP em `apps/mcp-server` e conhecimento em `packages/knowledge`. Não é o schema de rota da API. Evitar criar novos contratos paralelos: contratos publicados continuam definidos em `protocols/`. |
| `drizzle-orm` + `drizzle-kit` | **Em uso** | Acesso SQL e migrations de `packages/database`. PostgreSQL FTS e `pgvector` são a base; ParadeDB é uma extensão futura condicionada a avaliações. |
| `pg-boss` | **Em uso no Hub** | Fila e agendamento persistentes no PostgreSQL, consumidos por `apps/worker`. Não é a fila do Edge, que usa SQLite. |
| `web-tree-sitter` + `@repomix/tree-sitter-wasms` | **Em uso na descoberta** | `packages/project-discovery` carrega localmente parsers WASM para Python, Go, Java e Rust; TS/JS continuam no AST do compilador TypeScript. Não há download de gramáticas em runtime. O pacote de gramáticas acrescenta 23,9 MB descompactados; o resultado do `brain init` informa idiomas ativos e arquivos que usaram o fallback determinístico. |
| `dependency-cruiser` | **Em uso** | Verificação de dependências e ciclos em JS/TS. |
| `js-yaml` + `zod` | **Em uso** | Parsing de YAML e validação em `packages/knowledge`. `gray-matter` não está atualmente declarado como dependência. |
| `js-tiktoken` | **Em uso** | Contagem de tokens em `packages/context-engine`, `context-optimizer` e `ingestion`. Não adicionar `tiktoken` separado. |
| [`jose`](https://github.com/panva/jose) | **Em uso — P1, segurança** | `packages/auth` valida HS256/RS256 via `jwtVerify`, allowlist de algoritmos, issuer e audience configurados, JWKS remoto com seleção estrita por `kid`, e converte claims validados para `AuthContext`. Erros criptográficos e claims inválidos falham como 401. |
| [`ollama`](https://github.com/ollama/ollama-js) | **Em uso — P2, manutenção** | `apps/agent-runner` usa `generate({ model, prompt, stream: false })` e `apps/worker` usa `embed({ model, input })`; ambos mantêm endpoint/modelo explícitos e injetam `fetch` para teste. O SDK não instala/inicia o daemon nem baixa modelos automaticamente; fila, scheduler e ciclo do Runner continuam no Noema. |
| Apple Foundation Models CLI `fm` | **Provedor local opcional — macOS compatível; integração do Runner a implementar/validar** | Permitir que o usuário escolha o modelo local de sistema da Apple para tarefas do Brain Runner em Macs onde `fm available` confirme prontidão. `fm serve` oferece API local Chat Completions (`/health`, `/v1/models`, `/v1/chat/completions`); criar adaptador próprio ou compatível e validar tool calling MCP, streaming, cancelamento, saída estruturada e limites. O `fm` não é uma dependência cross-platform nem provedor de embeddings. A seleção deve ser explícita e não pode fazer fallback remoto automático. |
| [`@fastify/type-provider-typebox`](https://github.com/fastify/fastify-type-provider-typebox) | **Em uso parcial — P3, consistência de tipos** | `buildApp` aplica o provider; as rotas com schemas compatíveis inferem `params`, `querystring` e `body` a partir do TypeBox. Contexto e criação de tarefas mantêm tipos explícitos porque os schemas atuais são mais amplos que os tipos internos; restringi-los alteraria o contrato publicado. Rotas sem schema continuam tipadas explicitamente até receberem schema canônico. Usa a linha 5.x compatível com Fastify 5 e `@sinclair/typebox` 0.34. |
| `octokit` | **Condicional — quando a integração REST crescer** | Considerar no conector GitHub quando ele precisar de vários endpoints REST, paginação, tratamento de rate limit ou retries. Não substitui operações Git locais nem a validação criptográfica de webhooks, que permanece com `node:crypto`. |
| [`better-sqlite3-multiple-ciphers`](https://github.com/m4heshd/better-sqlite3-multiple-ciphers) | **Aposentada (`database-edge` removido)** | O pacote SQLite/Edge separado foi removido em favor da arquitetura unificada em PostgreSQL + `.brain/` controlado por `NOEMA_DEPLOYMENT_MODE=local|cloud` e `.env`. |
| `simple-git` | **Não recomendado para adoção inicial** | O código atual executa Git com `execFile` e argumentos separados. Manter essa abordagem enquanto as operações forem poucas; reavaliar uma biblioteca se surgirem fluxos Git complexos. A referência anterior a `simple-git` como se já fosse usada foi removida. |

### Command Center e operações HumanOps

O Command Center (`apps/web`) já utiliza **TanStack Query**, **TanStack Table**, **Recharts**, **cmdk** e **Lucide React** para carregamento automático, tabelas ordenáveis/filtráveis, gráficos interativos, grafo clicável e Command Palette (`⌘K`).

| Biblioteca | Estado | Onde / ganho esperado / limite |
| :--- | :--- | :--- |
| [`@tanstack/react-query`](https://tanstack.com/query/latest/docs/framework/react/overview) | **Em uso — `apps/web`** | Gerencia fetching, cache, refetch em segundo plano e invalidação automática por projeto após mutações (aprovações, cadastro de projetos, ingestão, FinOps e acesso). |
| [`@tanstack/react-table`](https://tanstack.com/table/latest/docs/introduction) | **Em uso — `apps/web`** | Ordenação, filtros ao vivo e inspeção lateral em Conhecimento, Runner Tasks, Auditoria, Membros e Cobertura de Regras. |
| [`recharts`](https://recharts.org/) + [`cmdk`](https://cmdk.paco.me/) + [`lucide-react`](https://lucide.dev/) | **Em uso — `apps/web`** | Gráficos de saúde, distribuição por tipo e consumo FinOps, Command Palette (`⌘K`) e ícones da interface. |
| [`react-hook-form`](https://react-hook-form.com/get-started) + `@hookform/resolvers` | **Recomendada quando houver formulários de revisão mais ricos** | Gerenciar estado e validação de formulários complexos se necessário; `protocols/` permanece a fonte canônica da API. |
| [`Radix UI Primitives`](https://www.radix-ui.com/primitives) | **Opcional para controles interativos acessíveis** | Primitivas adicionais caso sejam necessários menus/popovers complexos além dos drawers e `cmdk` atuais. |

### Concorrência e fluxos duráveis

| Biblioteca | Estado | Onde / ganho esperado / limite |
| :--- | :--- | :--- |
| [`p-limit`](https://github.com/sindresorhus/p-limit) | **Avaliar com benchmark de ingestão** | Limitar concorrência ao gerar embeddings dos chunks em `apps/worker`, hoje processados sequencialmente por item. Testar throughput e falhas com limites configuráveis por provedor; manter escrita idempotente e backpressure. Não criar fila durável com `p-limit`: `pg-boss` continua responsável pelos jobs do Hub. |
| [`Temporal TypeScript SDK`](https://docs.temporal.io/develop/typescript) | **Condicional — workflows que aguardam pessoas por longos períodos** | Pode orquestrar revisão que aguarda decisão humana, lembretes, vencimentos, retomada após reinício e etapas com retry. A documentação já prevê Temporal como serviço opcional. Não substituir a fila comum do Hub (`pg-boss`) nem a fila local SQLite; adotar somente quando a durabilidade e a duração do processo justificarem operar o serviço Temporal. |
| [`Piscina`](https://github.com/piscinajs/piscina) | **Não compatível com o runtime declarado atualmente** | Pode isolar trabalho síncrono intensivo em CPU em um pool de worker threads, mas a versão atual requer Node.js 24+, enquanto o monorepo declara `>=22`. Não adotar sem elevar e validar a versão mínima do runtime e demonstrar via profiling que parsing/AST bloqueia o event loop. Não melhora chamadas de rede/Ollama que já são assíncronas. |

### Ordem e limites de adoção

1. [x] **P1 — `jose`:** migração em `packages/auth`; issuer, audience, algoritmo, assinatura e expiração têm validação com falha fechada.
2. **Edge — SQLCipher:** manter o binding `better-sqlite3-multiple-ciphers` no CLI; smoke tests de chave incorreta, backup/restauração e rebuild estão na matriz CI Ubuntu/macOS/Windows. Validado localmente em macOS arm64; aguardar jobs aprovados de Linux/Windows antes de declarar suporte confirmado.
3. [x] **P2 — `ollama`:** chamadas de geração e embeddings migradas para o SDK; instalação, download de modelos e execução de tarefas continuam fora do SDK.
4. **P3 — TypeBox provider:** reduzir duplicação de tipos na API sem mudar os contratos publicados em `protocols/`.
5. **Condicional — Octokit:** adotar apenas quando funcionalidades REST do conector justificarem a dependência.
6. **HumanOps — TanStack Query + Radix UI:** priorizar para feedback, atualização e acessibilidade no fluxo de revisão do Command Center; adicionar TanStack Table e React Hook Form quando filtros/listas e formulários exigirem.
7. **Desempenho — `p-limit`:** só paralelizar embeddings depois de medir o gargalo e estabelecer limite seguro para o modelo/provedor.

**Não adicionar apenas para substituir código pequeno:** `pg-boss` já é a fila persistente do Hub; a fila Edge é SQLite e seu scheduler é do CLI. RRF/ranking determinístico, hashes e primitivas criptográficas simples permanecem código próprio ou `node:crypto` quando isso for menor e auditável. Não adotar LangChain/LlamaIndex apenas para chamadas ao Ollama: o Noema já possui seus próprios contratos de retrieval, MCP e execução.

### Critérios para adotar uma dependência recomendada

1. Confirmar que resolve código manual existente e que não duplica uma dependência já instalada.
2. Conferir manutenção, licença permissiva (`MIT`, `Apache-2.0` ou `BSD-3-Clause`), suporte ao Node.js e às plataformas-alvo.
3. Implementar a troca no pacote responsável, mantendo os contratos públicos e a configuração explícita de provedores.
4. Atualizar `package.json` e `package-lock.json`; só então mudar o estado da tabela de **Recomendado** para **Em uso**.
5. Para SQLCipher, exigir `requireSqlCipher` em consumidores que guardam dados sensíveis e fazer prova de compatibilidade em cada plataforma suportada antes de declarar paridade multiplataforma.

### Ecossistema Python (`apps/ai-worker`)
| Biblioteca | Onde Entra | O que Resolve |
| :--- | :--- | :--- |
| `fastapi` | `apps/ai-worker` | Serviço interno de IA/Parsing acionado via HTTP/Temporal pelos workers TS |
| `docling` (IBM) + `markitdown` (Microsoft) | `apps/ai-worker` | **Parsing local disponível:** Docling é o parser preferido; MarkItDown é fallback. A rota autenticada de ingestão do Hub envia PDF, DOCX, PPTX, XLSX, HTML e CSV como bytes temporários ao AI Worker e persiste Markdown após Gitleaks/PII/OPA. Se ambos os parsers falharem, a ingestão é bloqueada. Formatos binários Office antigos que exigem LibreOffice e qualidade de OCR ainda não são suportados/avaliados. |
| `presidio-analyzer` + `presidio-anonymizer` | `packages/ingestion` | Detecção e mascaramento local de PII (LGPD) antes de gerar embeddings |
| `flashrank` | `packages/retrieval` | Reranking ultrarrápido local em CPU (ONNX), sem API paga |
| `litellm` | `apps/ai-worker`, `context-optimizer` | Interface única para usar **Ollama / vLLM** (padrão local/self-hosted) ou provedores pagos opcionais |
| `ragas` | `tests/retrieval-evals` | Avaliação automatizada de Precision, Recall e citações sem inventar métrica do zero |

---

## 2. Projetos Open-Source Simples para Adaptar ou Embutir

Em vez de reescrever utilitários complexos do zero, vale **adaptar ou forkar** projetos simples (especialmente em JS/TS ou CLI leve) para nossos pacotes:

| Projeto Open-Source | Estratégia | Onde Adaptar |
| :--- | :--- | :--- |
| **Repomix** (JS/TS) | Adaptar lógica de varredura, `.gitignore` e contagem de tokens | `packages/project-discovery` (`brain init` / *Autodiscovery*) |
| **Semgrep OSS** (CLI + regras YAML) | Executar em modo local/CI com regras customizadas por projeto | `packages/architecture-guardian` e `security` |
| **Gitleaks** (binário CLI leve) | Rodar como etapa pré-ingestão para bloquear tokens/chaves/senhas | `packages/ingestion` |
| **Promptfoo** (JS/TS) | Adaptar suíte de testes de prompt/retrieval no CI | `tests/retrieval-evals/` |
| **Sourcegraph SCIP** (indexadores OSS) | Consumir o protobuf oficial com bindings gerados; `brain init` lê índices existentes e `brain init --scip` invoca explicitamente `scip-typescript` ou `scip-python` | `packages/code-intelligence`, `packages/project-discovery`, `apps/cli` |
| **Modelo Temporal (estilo Graphiti)** | Adotar o modelo conceitual de validade temporal (`valid_from`/`valid_until`) diretamente sobre PostgreSQL CTEs (sem exigir Neo4j/FalkorDB) | `packages/temporal-knowledge` e `graph` |
| **Nango** (JS/TS OSS) | Self-hosted para OAuth e sync incremental de SaaS (Jira, Notion, Figma, Slack, CRM); `integrations/*` implementa os *mappers*. GitHub/GitLab usam App próprio; operações Git locais continuam via CLI enquanto simples, e `Octokit` é uma opção condicional apenas para REST. | `packages/connector-framework` |
| **Vercel AI SDK ou loop próprio + MCP SDK** (TS) | Avaliar somente se o Runner precisar de abstração multi-provedor/tool-calling padronizado; para HTTP direto ao Ollama, preferir o SDK oficial `ollama`. A adoção não substitui fila, scheduler, sandbox ou controles de aprovação. | `apps/agent-runner` (*Brain Runner*) |
| **NanoClaw** (`nanocoai/nanoclaw`, TS) | Alternativa se precisar de isolamento por container por sessão de subagente | `apps/agent-runner` (modo isolado) |

---

## 3. Infraestrutura Open-Source Oficial (Self-Hosted & Gratuita)

| Camada | Padrão Oficial da Plataforma | Alternativa Compatível (Opcional) |
| :--- | :--- | :--- |
| **Banco + Vetor + FTS + Grafo** | **PostgreSQL 16 + `pgvector >= 0.8`**, FTS nativo e `pg-boss` | ParadeDB (`pg_search` BM25) após evals; Postgres gerenciado compatível |
| **Embeddings & LLM Local** | Provedor de embeddings opcional: Ollama (`bge-m3`); geração local: Ollama ou Apple `fm` em macOS compatível, selecionado explicitamente | LiteLLM para provedores externos configurados |
| **Cache Distribuído** | Cache LRU local; Valkey 8 quando houver múltiplas réplicas | Serviço Redis compatível |
| **Orquestração Durável** | Temporal.io opcional para workflows longos com timers/aprovações | Temporal Cloud |
| **Object Storage** | MinIO opcional para patches/arquivos grandes | AWS S3 / Cloudflare R2 |
| **Autenticação (Nuvem)** | **Keycloak** (OIDC + Multi-Tenant) — *no modo Local-First usa API Key simples* | Zitadel / Auth0 / Clerk |
| **Políticas de Acesso** | **OPA (Open Policy Agent)** para regras ABAC/RBAC declarativas | — |
| **Observabilidade & Traces IA** | **OpenTelemetry + Jaeger** + **Langfuse (self-hosted)** | Arize Phoenix / Datadog |

> **Decisão de busca lexical:** PostgreSQL FTS é o padrão inicial. ParadeDB (`pg_search`) é um upgrade opcional quando os evals demonstrarem ganho suficiente para justificar a dependência adicional.

---

## 4. Resumo: O que Integrar vs. O que Construir (Core IP)

- **Não reinvente (Integre ou Adapte):** Parsing de docs quando necessário (`Docling`), AST/Símbolos (`Tree-sitter`, depois `SCIP`), Regras de código (`Semgrep`/`dependency-cruiser`), Segredos/PII (`Gitleaks`, `Presidio` sob demanda), Busca (PostgreSQL FTS + `pgvector`; ParadeDB depois de evals), embeddings locais opcionais (`Ollama`), conectores SaaS (Nango quando houver pelo menos 2), autenticação corporativa (Keycloak/OPA) e evals de retrieval.
- **Construa como diferencial próprio (Core IP):**
  1. **Context Router & Optimizer** (seleção pelos 12 domínios + *Context Hit Rate*).
  2. **Business Rule Engine** conectado ao código via `@brain-rule` / `@brain-adr`.
  3. **Agent Continuity Protocol (`Agent Handoff`)** com sincronização real de branch/patch entre Antigravity, Codex, Kiro, Cursor e Claude Code.
  4. **Project Command Center** unificando aprovações humanas, saúde do conhecimento e rastreabilidade negócio ↔ código.

