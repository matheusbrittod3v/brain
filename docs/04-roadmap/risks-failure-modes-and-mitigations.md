# Matriz de Riscos, Falhas Esperadas e Mitigações

Construir uma plataforma que une código, regras de negócio, grafo temporal e múltiplos agentes de IA envolve armadilhas reais de engenharia. Esta matriz antecipa os principais modos de falha e define como o sistema deve reagir.

---

## 1. Falhas de Sincronização, Dados e Drift

| Falha / Dificuldade | Sintoma | Causa Raiz | Mitigação Arquitetural |
| :--- | :--- | :--- | :--- |
| **Dessincronização Git ↔ Postgres** | Decisão registrada no Noema ainda não aparece no Git autoritativo, ou commit recente não aparece na busca | PR não foi mesclado, webhook perdido, conflito ou worker offline | Aprovação do painel/canal não substitui merge quando Git é fonte autoritativa; todo sync tem **reconciliação periódica por hash** (`git ls-tree`), retry exponencial em `pg-boss` e indicador de `last_synced_commit` visível na IDE |
| **Troca de Modelo de Embedding** | Busca vetorial retorna resultados sem sentido após mudar de `bge-m3` para outro modelo | Vetores de modelos/dimensões diferentes misturados no mesmo índice | Coluna `embedding_model` obrigatória; reindexação em *blue-green* (nova tabela/partição) antes de chavear a busca |
| **Falsos Positivos no Autodiscovery** | IA gera regras de negócio erradas ao ler código legado confuso | Heurística ou LLM infere regra sem contexto completo | Todo item gerado por `Autodiscovery` nasce obrigatoriamente como `status: draft` e `confidence < 1.0`, nunca entra como regra oficial sem revisão |
| **Rate Limit da API do GitHub** | Ingestão de vários microsserviços online é bloqueada com HTTP 403/429 | Polling excessivo ou leitura arquivo a arquivo via REST API | Priorizar webhooks + *shallow/partial clone* (`--depth 1 --filter=blob:none`), usar `ETag`/conditional requests e cache LRU local (Valkey opcional em escala horizontal) |
| **Mistura de Repo Externo com Regra Interna** | Código/doc de SDK open-source (`external_reference`) aparece como padrão ou regra da empresa | Falta de isolamento epistemológico na busca | Marcar referências com `sourceOrigin: "external_reference"`, `sourceKind: "git"` e `trustLevel: "untrusted"`; mantê-las somente para leitura e excluí-las dos domínios de regras internas (`01`, `02`, `11`) |

---

## 2. Falhas de Recuperação, Latência e Custo

| Falha / Dificuldade | Sintoma | Causa Raiz | Mitigação Arquitetural |
| :--- | :--- | :--- | :--- |
| **Lentidão em Embedding/Reranking Opcional** | `brain_context_build` passa de 5–10s quando há modelo local | Modelo grande demais ou concorrência alta na CPU | Ollama e FlashRank são opcionais; aplicar timeout por provedor, cache LRU local/Valkey opcional e fallback seguro para PostgreSQL FTS + Grafo |
| **Estouro de Tokens / Ruído no Context Pack** | Agente ignora regras importantes porque o contexto veio gigante e poluído | Inclusão de arquivos inteiros em vez de resumos e falta de poda | Orçamento rígido de tokens (`Context Optimizer`), contexto hierárquico (resumo primeiro, código sob demanda) e ajuste automático via **Context Hit Rate** |
| **Alucinação de Relações no Grafo** | Sistema afirma que um serviço afeta uma regra sem ser verdade | Arestas inferidas tratadas como fatos confirmados | Separação estrita `is_inferred = true` (apresentado como *hipótese* com evidência) vs. arestas determinísticas (`@brain-rule`, SCIP, YAML) |

---

## 3. Falhas no Agent Continuity Protocol (Multi-IDE)

| Falha / Dificuldade | Sintoma | Causa Raiz | Mitigação Arquitetural |
| :--- | :--- | :--- | :--- |
| **Conflito de Patch ao Trocar de IDE** | `brain_resume_handoff` falha ao aplicar mudanças do Antigravity no Codex/Kiro | O dev já editou outros arquivos na segunda máquina ou mudou de branch | Checagem prévia de `git status` e `baseCommitSha`; se houver conflito, cria branch isolada `handoff/<id>` em vez de sobrescrever o working tree |
| **Agente Trava no Meio da Sessão** | Sessão cai sem chamar `brain_create_handoff` | Queda de rede, limite de contexto ou fechamento abrupto da IDE | Gravação incremental de **checkpoints parciais** na *Working Memory* (PostgreSQL no Hub; SQLite no Edge) a cada passo relevante |
| **Diferença de Ambiente Local** | Testes passam no Antigravity mas falham no Codex/Kiro | Versões diferentes de Node/Python, `.env` faltando ou Docker parado | O manifesto `.project-brain.json` e o Handoff registram pré-requisitos de runtime (ex.: versão Node/Python e serviços Docker necessários) |

---

## 4. Falhas de Segurança e Governança

| Falha / Dificuldade | Sintoma | Causa Raiz | Mitigação Arquitetural |
| :--- | :--- | :--- | :--- |
| **Vazamento Cross-Tenant no Cache ou Grafo** | Usuário vê trecho ou existência de nó de outro projeto/nível de sigilo | Chave de cache sem `policyHash` ou travessia no grafo sem checar destino | Chave de cache local/Valkey usa `(tenantId, projectId, policyHash, indexVersion)`; `knowledge_relations` filtra `from_policy_id` e `to_policy_id` em todo salto; busca vetorial padrão usa exact scan no subconjunto autorizado; testes em `tests/security/` |
| **Prompt Injection via Issues/PRs** | Agente tenta executar ação indevida após ler comentário malicioso ingerido | Texto externo não confiável misturado com instruções do sistema | Tag `trustLevel: "untrusted"` obrigatória no `Context Pack`, sanitização na ingestão e proibição absoluta de tools MCP aprovarem regras oficiais |
| **Aprovação falsa ou repetida por canal** | Usuário não autorizado, evento repetido ou resposta citada parece aprovar proposta | Callback sem assinatura validada, identidade externa não mapeada ou falta de idempotência/versão | Validar assinatura do provedor; resolver identidade para `actorId` e revalidar papel/projeto no ato; exigir ação estruturada, versão e chave idempotente; auditar tentativa e decisão; nunca inferir aprovação de texto livre ou timeout |
| **Vazamento de Segredo no Índice Vetorial** | Chave de API ou senha aparece em busca semântica | Arquivo `.env` ou log com credencial foi indexado | `Gitleaks` + `Presidio` rodam **antes** da persistência no banco e geração de embeddings; falha de scanner bloqueia o chunk |

---

## 5. Dificuldades Organizacionais e de Adoção

| Dificuldade | Sintoma | Mitigação |
| :--- | :--- | :--- |
| **Fadiga de Aprovação (*Approval Fatigue*)** | *Living Documentation* abre 20 PRs pequenos por dia e ninguém revisa | Agrupar sugestões em **lotes por release/sprint** ou por PR de funcionalidade, com resumo de impacto claro |
| **Complexidade Operacional Inicial** | Time trava tentando subir serviços corporativos no dia 1 | Perfil **Local-First (`docker compose up`)** sobe PostgreSQL 16 (`pgvector` + `pg-boss`) com API Key local; Temporal, Keycloak/OPA, Valkey, MinIO, Ollama e Langfuse entram sob demanda |
| **Resistência de Devs a Documentar** | Ninguém escreve YAML/ADR manualmente | `brain init` gera os primeiros rascunhos, âncoras `@brain-rule` são comentários de 1 linha no código e `brain_change_propose` permite que o próprio agente redija o PR da documentação |
| **Bloqueio de PRs em Código Legado** | Guardians travam entregas do time ao serem ligados no dia 1 | Modo progressivo no CI: começar em `audit` → `advisory` (só comenta) → `enforced` apenas em código novo ou rotas `@brain-rule` |
| **Notebooks 8 GB RAM / Falha `sqlite-vec`** | Swap pesado no Ollama ou erro de extensão nativa C no SQLite local | Perfil `Lite` no `brain runner up --local` (1.5B–3B sob demanda) e fallback automático para busca lexical SQLite FTS5 pura |

