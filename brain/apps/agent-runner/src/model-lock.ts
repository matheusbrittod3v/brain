import { readFileSync } from "node:fs";

export interface ModelLockEntry {
  name: string;
  role: string;
  license: string;
  minRamGb: number;
  sizeMb?: number;
  maxSizeMb?: number;
  sha256: string;
}

const PERMISSIVE_LICENSES = new Set(["MIT", "Apache-2.0"]);
const SHA256_DIGEST_REGEX = /^sha256:[a-f0-9]{64}$/i;
const DEFAULT_MAX_MODEL_SIZE_MB = 8192;

export function validateModelLockEntry(entry: ModelLockEntry, maxSizeMbLimit = DEFAULT_MAX_MODEL_SIZE_MB): boolean {
  if (!PERMISSIVE_LICENSES.has(entry.license)) return false;
  if (!SHA256_DIGEST_REGEX.test(entry.sha256)) return false;
  const effectiveMax = entry.maxSizeMb ?? maxSizeMbLimit;
  if (effectiveMax <= 0 || effectiveMax > maxSizeMbLimit) return false;
  if (entry.sizeMb !== undefined && (entry.sizeMb <= 0 || entry.sizeMb > effectiveMax)) return false;
  return true;
}

export interface ModelLockManifest {
  schemaVersion: string;
  models: ModelLockEntry[];
}

export function loadAndVerifyModelLock(
  lockPath: string,
  options: { maxSizeMb?: number } = {}
): ModelLockManifest {
  const raw = readFileSync(lockPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<ModelLockManifest>;
  if (!parsed || !Array.isArray(parsed.models) || parsed.models.length === 0) {
    throw new Error(`models.lock.json inválido em '${lockPath}': campo 'models' ausente ou vazio.`);
  }
  const maxSizeMbLimit = options.maxSizeMb ?? DEFAULT_MAX_MODEL_SIZE_MB;
  const invalid: string[] = [];
  for (const entry of parsed.models) {
    if (!validateModelLockEntry(entry, maxSizeMbLimit)) {
      invalid.push(`${entry.name ?? "unknown"} (license=${entry.license}, sha256=${entry.sha256}, sizeMb=${entry.sizeMb ?? "n/a"}, maxSizeMb=${entry.maxSizeMb ?? "n/a"})`);
    }
  }
  if (invalid.length > 0) {
    throw new Error(`Modelos inválidos em '${lockPath}': ${invalid.join("; ")}`);
  }
  return {
    schemaVersion: parsed.schemaVersion ?? "1.0.0",
    models: parsed.models
  };
}

export type TaskComplexity = "simple" | "structured" | "complex";

export interface ModelRouteDecision {
  complexity: TaskComplexity;
  tier: "local-small" | "local-structured" | "escalate";
  model: string;
  useStructuredOutputs: boolean;
  escalateToCloud: boolean;
  reason: string;
}

export function selectModelForTask(complexity: TaskComplexity): ModelRouteDecision {
  switch (complexity) {
    case "simple":
      return {
        complexity,
        tier: "local-small",
        model: process.env.RUNNER_LITE_MODEL ?? "qwen2.5-coder:3b",
        useStructuredOutputs: false,
        escalateToCloud: false,
        reason: "Tarefa simples atendida localmente por modelo 1.5B–3B."
      };
    case "structured":
      return {
        complexity,
        tier: "local-structured",
        model: process.env.RUNNER_STRUCTURED_MODEL ?? "qwen2.5-coder:7b",
        useStructuredOutputs: true,
        escalateToCloud: false,
        reason: "Tarefa estruturada requer modelo 7B+ com JSON Schema Structured Outputs."
      };
    case "complex":
      return {
        complexity,
        tier: "escalate",
        model: process.env.RUNNER_ESCALATION_MODEL ?? "cloud-escalation",
        useStructuredOutputs: true,
        escalateToCloud: true,
        reason: "Tarefa complexa escalada para provedor externo ou revisão humana."
      };
  }
}

