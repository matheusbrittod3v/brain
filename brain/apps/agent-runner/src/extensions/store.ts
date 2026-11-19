import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RunnerMcpServerItem, RunnerPluginItem } from "./presets.js";

interface ExtensionsStoreShape {
  pluginsByProject: Record<string, Record<string, RunnerPluginItem>>;
  mcpsByProject: Record<string, Record<string, RunnerMcpServerItem>>;
}

const memoryStore: ExtensionsStoreShape = {
  pluginsByProject: {},
  mcpsByProject: {}
};

let diskLoaded = false;

function resolveStoreFile(): string {
  const localBrain = join(process.cwd(), ".brain");
  if (existsSync(localBrain)) return join(localBrain, "runner-extensions.json");
  return join(homedir(), ".brain", "runner-extensions.json");
}

function ensureLoaded(): void {
  if (diskLoaded) return;
  diskLoaded = true;
  try {
    const file = resolveStoreFile();
    if (!existsSync(file)) return;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ExtensionsStoreShape>;
    if (parsed.pluginsByProject) memoryStore.pluginsByProject = parsed.pluginsByProject;
    if (parsed.mcpsByProject) memoryStore.mcpsByProject = parsed.mcpsByProject;
  } catch {
    // Ignore malformed store
  }
}

export function persistExtensionsStore(): void {
  try {
    const file = resolveStoreFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(memoryStore, null, 2), "utf8");
  } catch {
    // Non-fatal in read-only sandboxes
  }
}

export function getProjectPluginsMap(projectId: string): Record<string, RunnerPluginItem> {
  ensureLoaded();
  if (!memoryStore.pluginsByProject[projectId]) {
    memoryStore.pluginsByProject[projectId] = {};
  }
  return memoryStore.pluginsByProject[projectId]!;
}

export function getProjectMcpsMap(projectId: string): Record<string, RunnerMcpServerItem> {
  ensureLoaded();
  if (!memoryStore.mcpsByProject[projectId]) {
    memoryStore.mcpsByProject[projectId] = {};
  }
  return memoryStore.mcpsByProject[projectId]!;
}

