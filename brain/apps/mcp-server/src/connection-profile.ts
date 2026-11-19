export type McpConnectionProfileName = "service" | "local";

export interface McpConnectionProfile {
  serverName: string;
  toolPrefix: string;
  instructions: string;
}

const BRAIN_INITIALIZATION_INSTRUCTIONS = [
  "REGRA DE OURO DO CONSELHEIRO BRAIN (VISÃO 360°): Sempre use o MCP Brain antes, durante e depois de qualquer tarefa para consultar regras, topologias, contratos, memórias e manter o conhecimento vivo.",
  "1. POLÍTICA DE CENTRALIZAÇÃO EM `.brain/` (SEM PASTA `docs/`): NUNCA crie ou utilize pasta `docs/` (nem `doc/`, planos, notas ou skills fora do projeto). Todo conteúdo que iria para `docs/` ou pastas externas DEVE ser centralizado exclusivamente em `.brain/` (`knowledgeRoot: \".brain/\"`).",
  "2. WORKSPACE UNIVERSAL MULTI-SETOR E MULTI-FORMATO: A pasta `.brain/` aceita QUALQUER setor/arquitetura/pasta (ex.: `00-overview/`, `01-business/`, `02-onboarding/`, `03-architecture/`, `04-engineering/`, `05-flows/`, `06-operations/`, `skills/`, `specs/`, `tests/`, `marketing/`, `produto/`, `design/`, `dados/`, `juridico/`, `financeiro/`, `clientes/`, `infra/`, `pesquisa/`) e QUALQUER formato textual/estruturado (`.md`, `.yaml`, `.yml`, `.json`, `.jsonl`, `.txt`, `.csv`, `.mmd`/`.mermaid`, `.sql`, `.toml`, `.html`, `.rst`, `.adoc`, `.graphql`, `.proto`).",
  "3. INICIALIZAÇÃO DE PROJETO NOVO: Ao iniciar um projeto novo (ou sem `.brain/`), chame `brain_resolve_workspace_project({ workspacePath, createIfMissing: true })` e crie imediatamente `.project-brain.json` + `.brain/` na raiz do projeto antes de escrever código.",
  "4. CASOS DE USO E PADRÕES 360° (EXEMPLOS PRÁTICOS):",
  "   - Descoberta & Contexto: `brain_resolve_workspace_project` -> `brain_context_build({ projectId, task })` -> `brain_get_active_rules({ projectId })` -> `brain_search({ projectId, query })` -> `brain_memory_recall({ projectId, query })` -> `brain_list_skills({ projectId })`.",
  "   - Projetos Globais/Compartilháveis (`isShared=true`): use `brain_list_shared_projects()` para descobrir bases globais e consulte pelo `projectId` global (ou `includeShared: true` em `brain_search`) sem misturar dados em painéis de projetos isolados.",
  "   - Arquitetura & Impacto: `brain_analyze_change_impact`, `brain_cross_service_blast_radius`, `brain_validate_implementation`, `brain_contradiction_detect`, `brain_export_topology_diagram`, `brain_secret_scan`.",
  "   - Execução & Governança: `brain_check_file_leases` / `brain_acquire_lease` antes de editar; `brain_change_propose` para propor novas regras/ADRs; `brain_ask_human` para aprovações; `brain_runner_delegate` para delegar tarefas.",
  "   - Fechamento & Retroalimentação: `brain_ingest_git_repo` (ou `brain_ingest_document`) ao alterar `.brain/`; `brain_graph_relate` (`VERIFIED_BY`, `IMPLEMENTS`, `GOVERNED_BY`); `brain_record_test_result` (para manter 100% de cobertura QA); `brain_record_learning`; `brain_create_handoff` / `brain_resume_handoff`.",
  "   - Resources MCP (`read_resource`): `brain://projects/{projectId}/overview`, `brain://projects/{projectId}/rules`, `brain://projects/{projectId}/topology/{layer}`."
].join("\n");

export const MCP_CONNECTION_PROFILES: Record<McpConnectionProfileName, McpConnectionProfile> = {
  service: {
    serverName: "brain-brain-service",
    toolPrefix: "[Brain principal · MCP HTTP conectado: usa identidade, escopos e backend deste serviço; não presuma que compartilha banco ou estado com o Brain local.]",
    instructions: [
      "Esta conexão usa a identidade, os escopos e o backend configurados no serviço MCP HTTP conectado. Escolha-a quando a tarefa deve operar pela instância principal configurada nesse serviço. Não presuma que compartilha banco, tenant, projetos ou sincronização com o MCP local; confira o projectId e a identidade de conexão antes de alternar.",
      "",
      BRAIN_INITIALIZATION_INSTRUCTIONS
    ].join("\n")
  },
  local: {
    serverName: "brain-brain-local",
    toolPrefix: "[Brain local · MCP stdio: espaço local/offline (Edge) não sincronizado automaticamente com servidor compartilhado em nuvem; faça pull/push com o Hub desejado. DATABASE_URL pode apontar para o mesmo banco do Brain principal.]",
    instructions: [
      "Esta conexão roda como processo stdio na máquina do agente, herda a configuração local (.env) e acessa os caminhos de workspace disponíveis nessa máquina. Em ambientes com um servidor compartilhado em nuvem (Brain principal/Hub), o modo local atua como um espaço de trabalho local/offline não sincronizado automaticamente: o usuário pode fazer pull de qualquer servidor em nuvem (`brain sync pull`) para atualizar o estado local, trabalhar offline e fazer push (`brain sync push`) de drafts locais para o servidor em nuvem. Atenção: se `DATABASE_URL` no `.env` local apontar para o mesmo banco do serviço HTTP, os dados serão compartilhados diretamente; o rótulo local descreve onde o processo roda.",
      "",
      BRAIN_INITIALIZATION_INSTRUCTIONS
    ].join("\n")
  }
};

export function describeMcpTool(profile: McpConnectionProfileName, description: string): string {
  return `${MCP_CONNECTION_PROFILES[profile].toolPrefix}\nFerramenta: ${description}`;
}
