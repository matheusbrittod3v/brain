import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MCP_SERVER_PRESETS,
  PLUGIN_CATALOG_PRESETS,
  type McpTransportType,
  type PluginSource,
  type RunnerMcpPreset,
  type RunnerMcpServerItem,
  type RunnerPluginItem,
  type RunnerPluginPreset
} from "./presets.js";
import { getProjectMcpsMap, getProjectPluginsMap, persistExtensionsStore } from "./store.js";

export * from "./presets.js";
export { testRunnerMcpServer } from "./mcp-tester.js";

export function listRunnerPlugins(projectId: string): {
  installed: RunnerPluginItem[];
  presets: RunnerPluginPreset[];
} {
  const map = getProjectPluginsMap(projectId);
  return {
    installed: Object.values(map).sort((a, b) => a.name.localeCompare(b.name)),
    presets: PLUGIN_CATALOG_PRESETS
  };
}

export function installRunnerPlugin(
  projectId: string,
  input: {
    id: string;
    name?: string;
    version?: string;
    description?: string;
    source?: PluginSource;
    sourceRef?: string;
    category?: RunnerPluginItem["category"];
    skills?: string[];
    tools?: string[];
    hooks?: string[];
    config?: Record<string, string>;
    env?: Record<string, string>;
    enabled?: boolean;
  }
): RunnerPluginItem {
  const map = getProjectPluginsMap(projectId);
  const preset = PLUGIN_CATALOG_PRESETS.find((p) => p.id === input.id);
  const now = new Date().toISOString();
  const existing = map[input.id];

  const item: RunnerPluginItem = {
    id: input.id.trim(),
    name: input.name?.trim() || preset?.name || existing?.name || input.id.trim(),
    version: input.version?.trim() || preset?.version || existing?.version || "1.0.0",
    description: input.description?.trim() || preset?.description || existing?.description || "Plugin customizado conectado ao Brain Runner.",
    source: input.source || (preset ? "builtin" : existing?.source || "local"),
    sourceRef: input.sourceRef?.trim() || existing?.sourceRef,
    category: input.category || preset?.category || existing?.category || "workflow",
    enabled: input.enabled ?? existing?.enabled ?? true,
    skills: input.skills ?? preset?.skills ?? existing?.skills ?? [],
    tools: input.tools ?? preset?.tools ?? existing?.tools ?? [],
    hooks: input.hooks ?? preset?.hooks ?? existing?.hooks ?? [],
    config: input.config ?? existing?.config ?? { ...(preset?.defaultConfig ?? {}) },
    env: input.env ?? existing?.env ?? {},
    installedAt: existing?.installedAt || now,
    updatedAt: now
  };

  map[item.id] = item;
  persistExtensionsStore();
  return item;
}

export function updateRunnerPlugin(
  projectId: string,
  pluginId: string,
  patch: {
    enabled?: boolean;
    config?: Record<string, string>;
    env?: Record<string, string>;
    skills?: string[];
    tools?: string[];
    hooks?: string[];
  }
): RunnerPluginItem {
  const map = getProjectPluginsMap(projectId);
  const existing = map[pluginId];
  if (!existing) {
    throw new Error(`Plugin '${pluginId}' não está instalado neste projeto.`);
  }
  const updated: RunnerPluginItem = {
    ...existing,
    enabled: patch.enabled ?? existing.enabled,
    config: patch.config ?? existing.config,
    env: patch.env ?? existing.env,
    skills: patch.skills ?? existing.skills,
    tools: patch.tools ?? existing.tools,
    hooks: patch.hooks ?? existing.hooks,
    updatedAt: new Date().toISOString()
  };
  map[pluginId] = updated;
  persistExtensionsStore();
  return updated;
}

export function uninstallRunnerPlugin(projectId: string, pluginId: string): boolean {
  const map = getProjectPluginsMap(projectId);
  if (!map[pluginId]) return false;
  delete map[pluginId];
  persistExtensionsStore();
  return true;
}

export function listRunnerMcpServers(projectId: string): {
  servers: RunnerMcpServerItem[];
  presets: RunnerMcpPreset[];
} {
  const map = getProjectMcpsMap(projectId);
  return {
    servers: Object.values(map).sort((a, b) => a.name.localeCompare(b.name)),
    presets: MCP_SERVER_PRESETS
  };
}

export function upsertRunnerMcpServer(
  projectId: string,
  input: {
    id: string;
    name?: string;
    description?: string;
    transport?: McpTransportType;
    command?: string;
    args?: string[];
    url?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
    enabled?: boolean;
    source?: RunnerMcpServerItem["source"];
  }
): RunnerMcpServerItem {
  const map = getProjectMcpsMap(projectId);
  const preset = MCP_SERVER_PRESETS.find((p) => p.id === input.id);
  const now = new Date().toISOString();
  const existing = map[input.id];

  const transport: McpTransportType =
    input.transport || (input.url ? "http" : undefined) || preset?.transport || existing?.transport || "stdio";

  const item: RunnerMcpServerItem = {
    id: input.id.trim(),
    name: input.name?.trim() || preset?.name || existing?.name || input.id.trim(),
    description: input.description?.trim() ?? preset?.description ?? existing?.description,
    transport,
    command: transport === "stdio" ? (input.command?.trim() || preset?.command || existing?.command) : undefined,
    args: transport === "stdio" ? (input.args ?? preset?.args ?? existing?.args ?? []) : undefined,
    url: transport !== "stdio" ? (input.url?.trim() || preset?.url || existing?.url) : undefined,
    headers: transport !== "stdio" ? (input.headers ?? existing?.headers ?? {}) : undefined,
    env: input.env ?? existing?.env ?? {},
    enabled: input.enabled ?? existing?.enabled ?? true,
    source: input.source || (preset ? "preset" : existing?.source || "manual"),
    lastTest: existing?.lastTest,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };

  map[item.id] = item;
  persistExtensionsStore();
  return item;
}

export function updateRunnerMcpServerStatus(
  projectId: string,
  serverId: string,
  enabled: boolean
): RunnerMcpServerItem {
  const map = getProjectMcpsMap(projectId);
  const existing = map[serverId];
  if (!existing) {
    throw new Error(`MCP Server '${serverId}' não encontrado.`);
  }
  const updated: RunnerMcpServerItem = {
    ...existing,
    enabled,
    updatedAt: new Date().toISOString()
  };
  map[serverId] = updated;
  persistExtensionsStore();
  return updated;
}

export function deleteRunnerMcpServer(projectId: string, serverId: string): boolean {
  const map = getProjectMcpsMap(projectId);
  if (!map[serverId]) return false;
  delete map[serverId];
  persistExtensionsStore();
  return true;
}

export function importMcpServersJson(
  projectId: string,
  raw: unknown,
  source: RunnerMcpServerItem["source"] = "imported"
): RunnerMcpServerItem[] {
  const parsed = typeof raw === "string" ? (JSON.parse(raw) as Record<string, unknown>) : (raw as Record<string, unknown>);
  const serversObj =
    (parsed?.mcpServers as Record<string, any>) ||
    (parsed?.servers as Record<string, any>) ||
    (parsed as Record<string, any>);

  if (!serversObj || typeof serversObj !== "object") {
    throw new Error("Formato inválido. Informe um JSON com a chave 'mcpServers'.");
  }

  const imported: RunnerMcpServerItem[] = [];
  for (const [id, cfg] of Object.entries(serversObj)) {
    if (!cfg || typeof cfg !== "object") continue;
    const hasUrl = typeof cfg.url === "string" || typeof cfg.serverUrl === "string";
    const hasCmd = typeof cfg.command === "string";
    if (!hasUrl && !hasCmd) continue;

    const item = upsertRunnerMcpServer(projectId, {
      id,
      name: typeof cfg.name === "string" ? cfg.name : id,
      description: typeof cfg.description === "string" ? cfg.description : undefined,
      transport: hasUrl ? (cfg.transport === "sse" ? "sse" : "http") : "stdio",
      command: typeof cfg.command === "string" ? cfg.command : undefined,
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : undefined,
      url: typeof cfg.url === "string" ? cfg.url : typeof cfg.serverUrl === "string" ? cfg.serverUrl : undefined,
      headers: cfg.headers && typeof cfg.headers === "object" ? cfg.headers : undefined,
      env: cfg.env && typeof cfg.env === "object" ? cfg.env : undefined,
      enabled: cfg.disabled === true ? false : true,
      source
    });
    imported.push(item);
  }
  return imported;
}

export function importLocalMcpConfigs(projectId: string): {
  imported: RunnerMcpServerItem[];
  sources: string[];
} {
  const home = homedir();
  const candidates = [
    join(process.cwd(), ".mcp.json"),
    join(home, ".cursor", "mcp.json"),
    join(home, ".claude.json"),
    join(home, ".gemini", "antigravity", "mcp_config.json")
  ];

  const imported: RunnerMcpServerItem[] = [];
  const sources: string[] = [];

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (!json || typeof json !== "object" || !("mcpServers" in json)) continue;
      const items = importMcpServersJson(projectId, json, "imported");
      if (items.length > 0) {
        imported.push(...items);
        sources.push(file);
      }
    } catch {
      // Ignore unreadable/malformed local config
    }
  }

  return { imported, sources };
}
