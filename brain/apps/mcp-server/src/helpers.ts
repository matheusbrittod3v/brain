import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { BrainError, type KnowledgeItem } from "@brain/core";
import type { KnowledgeItemVersion } from "@brain/knowledge";

export function configuredProjectWorkspaceRoots(): Readonly<Record<string, string>> {
  const raw = process.env.BRAIN_PROJECT_WORKSPACE_ROOTS?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("BRAIN_PROJECT_WORKSPACE_ROOTS must be a JSON object mapping project IDs to workspace paths.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("BRAIN_PROJECT_WORKSPACE_ROOTS must be a JSON object mapping project IDs to workspace paths.");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([projectId, root]) => !projectId.trim() || typeof root !== "string" || !root.trim() || !isAbsolute(root))) {
    throw new Error("BRAIN_PROJECT_WORKSPACE_ROOTS values must be absolute paths keyed by non-empty project IDs.");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

export function resolveWorkspaceFile(workspaceRoot: string, inputPath: string): string {
  if (!inputPath.trim() || inputPath.includes("\0") || isAbsolute(inputPath)) {
    throw new BrainError("BRAIN_ERR_POLICY_DENIED", "A validação aceita apenas caminhos relativos dentro do workspace autorizado.", 403);
  }
  let root: string;
  try {
    root = realpathSync(resolve(workspaceRoot));
  } catch {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "O workspace configurado para validação não está disponível.", 503);
  }
  const candidate = resolve(root, inputPath);
  if (!isPathWithin(root, candidate)) {
    throw new BrainError("BRAIN_ERR_POLICY_DENIED", "O caminho solicitado está fora do workspace autorizado.", 403);
  }
  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    let ancestor = dirname(candidate);
    while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
    const realAncestor = realpathSync(ancestor);
    if (!isPathWithin(root, realAncestor)) {
      throw new BrainError("BRAIN_ERR_POLICY_DENIED", "O caminho solicitado está fora do workspace autorizado.", 403);
    }
    return candidate;
  }
  if (!isPathWithin(root, realCandidate)) {
    throw new BrainError("BRAIN_ERR_POLICY_DENIED", "O caminho solicitado está fora do workspace autorizado.", 403);
  }
  if (!statSync(realCandidate).isFile()) {
    throw new BrainError("BRAIN_ERR_POLICY_DENIED", "A validação aceita apenas arquivos dentro do workspace autorizado.", 403);
  }
  return realCandidate;
}

export function okJson(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export type KnowledgeLayer = "architecture" | "business" | "code" | "product" | "operations" | "general";
export type KnowledgeFormat = "markdown" | "mermaid" | "topology" | "flow" | "code";

export function inferKnowledgeLayer(item: { type: string; tags?: string[] }): KnowledgeLayer {
  const tags = item.tags ?? [];
  const tagged = tags.find((t) => t.startsWith("layer:"));
  if (tagged) {
    const val = tagged.slice(6) as KnowledgeLayer;
    if (["architecture", "business", "code", "product", "operations", "general"].includes(val)) return val;
  }
  const t = item.type.toLowerCase();
  if (["architecture_decision", "diagram", "topology", "system_architecture"].includes(t)) return "architecture";
  if (["business_rule", "domain_flow"].includes(t)) return "business";
  if (["code_symbol", "api_contract", "schema", "test"].includes(t)) return "code";
  if (["spec", "requirement", "ux_flow"].includes(t)) return "product";
  if (["runbook", "pipeline", "security_policy"].includes(t)) return "operations";
  return "general";
}

export function inferKnowledgeFormat(item: { content: string; tags?: string[] }): KnowledgeFormat {
  const tags = item.tags ?? [];
  const tagged = tags.find((t) => t.startsWith("format:"));
  if (tagged) {
    const val = tagged.slice(7) as KnowledgeFormat;
    if (["markdown", "mermaid", "topology", "flow", "code"].includes(val)) return val;
  }
  const c = item.content || "";
  if (/```topology/i.test(c) || (/"nodes"\s*:/.test(c) && /"edges"\s*:/.test(c))) return "topology";
  if (/```mermaid/i.test(c) || /^\s*(graph|flowchart|sequenceDiagram|classDiagram|erDiagram|stateDiagram)/m.test(c)) return "mermaid";
  if (/```(ts|typescript|js|sql|json|yaml|py|go)/i.test(c)) return "code";
  if (/^\s*\d+\.\s+.+\n\s*\d+\.\s+/m.test(c) && /->|=>|→/.test(c)) return "flow";
  return "markdown";
}

export function extractDiagrams(content: string): Array<{ kind: "mermaid" | "topology"; source: string }> {
  const out: Array<{ kind: "mermaid" | "topology"; source: string }> = [];
  const regex = /```(mermaid|topology)\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    out.push({ kind: match[1]!.toLowerCase() as "mermaid" | "topology", source: match[2]!.trim() });
  }
  return out;
}

export function computeKnowledgeQuality(item: { title: string; content: string; status: string; tags?: string[]; type: string }): {
  score: number;
  grade: "A" | "B" | "C" | "D";
} {
  let score = 0;
  const content = item.content || "";
  if (item.title.trim().length >= 5 && content.trim().length >= 100) score += 25;
  else if (content.trim().length >= 30) score += 12;

  const tags = item.tags ?? [];
  if (tags.some((t) => t.startsWith("layer:")) || item.type !== "document") score += 10;
  if (tags.some((t) => t.startsWith("format:")) || /```/.test(content)) score += 10;
  if (extractDiagrams(content).length > 0 || /^#{1,3}\s+/m.test(content)) score += 25;
  if (tags.length >= 2) score += 15;
  else if (tags.length === 1) score += 8;
  if (item.status === "approved") score += 15;

  const bounded = Math.min(100, score);
  const grade = bounded >= 85 ? "A" : bounded >= 65 ? "B" : bounded >= 40 ? "C" : "D";
  return { score: bounded, grade };
}

export function materializeKnowledgeItemVersion(current: KnowledgeItem, version: KnowledgeItemVersion): KnowledgeItem {
  const { itemId, ...versionFields } = version;
  return {
    ...current,
    ...versionFields,
    id: itemId,
    version: version.version,
    createdAt: version.createdAt,
    updatedAt: version.createdAt
  };
}

