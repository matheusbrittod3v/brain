export type McpConnectionProfileName = "service" | "local";

export interface McpConnectionProfile {
  serverName: string;
  toolPrefix: string;
  instructions: string;
}

const BRAIN_INITIALIZATION_INSTRUCTIONS = [
  "REGRA DE OURO DO CONSELHEIRO BRAIN: Sempre use o MCP Brain antes, durante e depois das tarefas para buscar conhecimento pronto (regras, topologias, contratos, memórias) e manter o cérebro atualizado.",
  "Estrutura `.brain/` e inicialização do projeto para consumo pelo Brain:",
  "0. Descoberta automática de projeto: antes de tudo, chame `brain_resolve_workspace_project` (passando o `workspacePath` ou `repoUrl` atual) para descobrir o `projectId` automaticamente sem depender de IDs no `.env`. Os projetos e políticas são resolvidos dinamicamente pelo seu usuário autenticado (JWT ou `~/.brain/credentials.json`).",
  "1. Antes de trabalhar em um projeto novo ou sem memória configurada, verifique se existem `.project-brain.json` e a pasta `.brain/` na raiz do repositório. Se não existirem (e você tiver acesso ao filesystem local), inicialize com `brain onboard` / `brain init` ou crie a estrutura mínima abaixo.",
  "2. Pastas e arquivos importantes em `.brain/` que o Brain consome:",
  "   - `.project-brain.json`: manifesto do projeto (`schemaVersion`, `tenantId`, `projectId`, `knowledgeRoot: \".brain/\"`, `guardianMode`, `accessPolicyId`).",
  "   - `.brain/00-overview/vision.md`: visão geral, objetivo, escopo e domínio do projeto (`VIS-<PROJETO>`).",
  "   - `.brain/01-business/business-rules/*.yaml`: regras de negócio e invariantes (`id: BR-...`, `type: business_rule`, `status`, `access_policy`, `description`).",
  "   - `.brain/02-onboarding/guide.md`: mapa de componentes, setup local e fluxo de trabalho.",
  "   - `.brain/03-architecture/decisions/ADR-*.md`: registros de decisão arquitetural com frontmatter (`id`, `title`, `status`, `access_policy`).",
  "   - `.brain/04-engineering/` (`coding-standards.md`, `security-standards.md`): padrões técnicos, segurança, PII e restrições de engenharia.",
  "3. Como funciona o consumo pelo Brain:",
  "   - A pasta `.brain/` é a fonte de verdade versionada em Git; os arquivos `.md` e `.yaml` são indexados no PostgreSQL (FTS + `pgvector` + grafo) via `brain_ingest_git`, `brain_ingest_document`, `brain_propose_knowledge`, `brain sync` ou webhook do GitHub.",
  "   - Após indexados, os agentes consultam esse conhecimento com `brain_context_build`, validam alterações contra regras/ADRs com `brain_validate_implementation` e preservam continuidade entre sessões com `brain_create_handoff` / `brain_resume_handoff`."
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
