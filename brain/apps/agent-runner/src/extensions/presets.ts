export type PluginSource = "builtin" | "local" | "npm" | "git";

export interface RunnerPluginItem {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  source: PluginSource;
  sourceRef?: string;
  category: "workflow" | "security" | "code" | "docs" | "integration";
  enabled: boolean;
  skills: string[];
  tools: string[];
  hooks: string[];
  config: Record<string, string>;
  env: Record<string, string>;
  installedAt: string;
  updatedAt: string;
}

export interface RunnerPluginPreset {
  id: string;
  name: string;
  version: string;
  description: string;
  category: RunnerPluginItem["category"];
  skills: string[];
  tools: string[];
  hooks: string[];
  defaultConfig: Record<string, string>;
}

export type McpTransportType = "stdio" | "http" | "sse";

export interface RunnerMcpServerItem {
  id: string;
  name: string;
  description?: string;
  transport: McpTransportType;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  enabled: boolean;
  source?: "manual" | "preset" | "imported";
  lastTest?: {
    ok: boolean;
    latencyMs?: number;
    serverName?: string;
    serverVersion?: string;
    toolsCount?: number;
    error?: string;
    testedAt: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface RunnerMcpPreset {
  id: string;
  name: string;
  description: string;
  transport: McpTransportType;
  command?: string;
  args?: string[];
  url?: string;
  requiredEnv?: string[];
}

export const PLUGIN_CATALOG_PRESETS: RunnerPluginPreset[] = [
  {
    id: "code-review-guard",
    name: "Code Review Guard",
    version: "1.2.0",
    description: "Revisa diffs, detecta regressões arquiteturais e valida aderência a specs antes do merge.",
    category: "code",
    skills: ["pr-review", "diff-audit"],
    tools: ["review_diff", "check_conventions"],
    hooks: ["pre-proposal-approve"],
    defaultConfig: { strictness: "balanced", maxFilesPerPass: "25" }
  },
  {
    id: "security-scanner",
    name: "Security & Secrets Scanner",
    version: "1.1.0",
    description: "Inspeciona credenciais expostas, padrões inseguros (OWASP) e permissões CASL.",
    category: "security",
    skills: ["secret-scan", "owasp-audit"],
    tools: ["scan_secrets", "audit_policies"],
    hooks: ["pre-task-execute"],
    defaultConfig: { blockOnCritical: "true", scanEnvFiles: "true" }
  },
  {
    id: "openspec-architect",
    name: "OpenSpec Architect",
    version: "1.0.4",
    description: "Converte requisitos em especificações estruturadas (.brain/specs) e planos de tarefas.",
    category: "workflow",
    skills: ["openspec-plan", "adr-writer"],
    tools: ["generate_spec", "split_tasks"],
    hooks: ["on-spec-created"],
    defaultConfig: { outputFormat: "markdown", autoLinkGraph: "true" }
  },
  {
    id: "test-generator",
    name: "Test Suite Generator",
    version: "1.0.2",
    description: "Gera casos de teste unitários e de integração a partir de regras de negócio e critérios de aceite.",
    category: "code",
    skills: ["vitest-gen", "e2e-scenarios"],
    tools: ["generate_tests", "coverage_gaps"],
    hooks: [],
    defaultConfig: { framework: "vitest", includeEdgeCases: "true" }
  },
  {
    id: "git-workflow",
    name: "Git & Release Workflow",
    version: "1.0.0",
    description: "Padroniza mensagens de commit, notas de release e verificação de branches.",
    category: "workflow",
    skills: ["conventional-commits", "release-notes"],
    tools: ["summarize_commits"],
    hooks: [],
    defaultConfig: { style: "conventional", language: "pt-BR" }
  },
  {
    id: "docs-sync",
    name: "Knowledge & Docs Sync",
    version: "1.0.1",
    description: "Mantém a base de conhecimento (.brain/) sincronizada com alterações de API e UI.",
    category: "docs",
    skills: ["docs-sync", "changelog-sync"],
    tools: ["sync_brain_docs"],
    hooks: ["post-task-complete"],
    defaultConfig: { autoDraftProposal: "true" }
  }
];

export const MCP_SERVER_PRESETS: RunnerMcpPreset[] = [
  {
    id: "filesystem",
    name: "Filesystem",
    description: "Leitura e navegação segura de diretórios autorizados do workspace.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "."]
  },
  {
    id: "github",
    name: "GitHub",
    description: "Consulta repositórios, issues, pull requests e commits via API do GitHub.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    requiredEnv: ["GITHUB_PERSONAL_ACCESS_TOKEN"]
  },
  {
    id: "postgres",
    name: "PostgreSQL",
    description: "Inspeção de schemas e consultas read-only em bancos PostgreSQL.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-postgres"],
    requiredEnv: ["POSTGRES_CONNECTION_STRING"]
  },
  {
    id: "playwright",
    name: "Playwright Browser",
    description: "Automação de navegador, inspeção visual e testes E2E.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"]
  },
  {
    id: "context7",
    name: "Context7 Docs",
    description: "Busca documentação atualizada de bibliotecas e frameworks em tempo real.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@upstash/context7-mcp@latest"]
  },
  {
    id: "fetch",
    name: "Web Fetch",
    description: "Busca e extração de conteúdo de páginas web e APIs HTTP.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-fetch"]
  },
  {
    id: "memory",
    name: "Memory Graph",
    description: "Memória persistente baseada em grafo de entidades e relações.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"]
  },
  {
    id: "sequential-thinking",
    name: "Sequential Thinking",
    description: "Raciocínio estruturado passo a passo para problemas complexos.",
    transport: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"]
  }
];

