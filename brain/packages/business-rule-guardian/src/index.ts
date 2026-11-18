import type { KnowledgeItem } from "@brain/core";
import { extractCodeAnchors } from "@brain/code-intelligence";

export type GuardianMode = "audit" | "advisory" | "enforced";
export type TestExecutionStatus = "passed" | "failed" | "skipped" | "not_run";

export interface BusinessRuleViolation {
  ruleId: string;
  severity: "warning" | "error";
  filePath: string;
  message: string;
}

export interface BusinessRuleCheckReport {
  mode: GuardianMode;
  passed: boolean;
  checkedRules: number;
  violations: BusinessRuleViolation[];
}

function toLookup<T>(input?: ReadonlyMap<string, T> | Record<string, T>): ReadonlyMap<string, T> | undefined {
  if (!input) return undefined;
  if (input instanceof Map) return input;
  return new Map(Object.entries(input));
}

function toSet(input?: ReadonlySet<string> | readonly string[]): ReadonlySet<string> | undefined {
  if (!input) return undefined;
  return input instanceof Set ? input : new Set(input);
}

/**
 * Avalia conformidade determinística de arquivos alterados contra BusinessRules,
 * âncoras @brain-rule, existência de arquivos de teste e status de execução (itens 81-82).
 */
export function evaluateBusinessRuleCompliance(opts: {
  mode: GuardianMode;
  files: Array<{ path: string; content: string }>;
  activeRules: readonly KnowledgeItem[];
  verifiedRuleIds?: ReadonlySet<string>;
  ruleTestFiles?: ReadonlyMap<string, readonly string[]> | Record<string, readonly string[]>;
  existingTestFiles?: ReadonlySet<string> | readonly string[];
  testExecutionResults?:
    | ReadonlyMap<string, TestExecutionStatus>
    | Record<string, TestExecutionStatus>;
}): BusinessRuleCheckReport {
  const violations: BusinessRuleViolation[] = [];
  const allBusinessRules = opts.activeRules.filter((r) => r.type === "business_rule");
  const approvedRules = allBusinessRules.filter((r) => r.status === "approved");
  const ruleMap = new Map(allBusinessRules.map((r) => [r.id, r]));

  const ruleTestMap = toLookup(opts.ruleTestFiles);
  const existingTests = toSet(opts.existingTestFiles);
  const executionMap = toLookup(opts.testExecutionResults);

  for (const file of opts.files) {
    const anchors = extractCodeAnchors(file.path, file.content);
    for (const anchor of anchors) {
      if (anchor.kind !== "brain-rule") continue;
      const rule = ruleMap.get(anchor.targetId);
      if (!rule) {
        violations.push({
          ruleId: anchor.targetId,
          severity: "warning",
          filePath: file.path,
          message: `Âncora @brain-rule '${anchor.targetId}' referencia regra inexistente.`
        });
        continue;
      }

      if (rule.status === "deprecated" || rule.status === "superseded") {
        violations.push({
          ruleId: rule.id,
          severity: "error",
          filePath: file.path,
          message: `Código referencia regra '${rule.id}' que está '${rule.status}'.`
        });
        continue;
      }

      if (rule.status !== "approved") {
        violations.push({
          ruleId: rule.id,
          severity: "warning",
          filePath: file.path,
          message: `Âncora @brain-rule '${rule.id}' referencia regra com status '${rule.status}' (não aprovada).`
        });
        continue;
      }

      if (opts.verifiedRuleIds && !opts.verifiedRuleIds.has(rule.id)) {
        violations.push({
          ruleId: rule.id,
          severity: "error",
          filePath: file.path,
          message: `Regra '${rule.id}' alterada em '${file.path}' não possui teste VERIFIED_BY ativo.`
        });
      }

      const linkedTests = ruleTestMap?.get(rule.id) ?? [];
      if (existingTests && linkedTests.length > 0) {
        const hasExistingTest = linkedTests.some((testPath) => existingTests.has(testPath));
        if (!hasExistingTest) {
          violations.push({
            ruleId: rule.id,
            severity: "error",
            filePath: file.path,
            message: `Nenhum arquivo de teste vinculado à regra '${rule.id}' existe no repositório (${linkedTests.join(", ")}).`
          });
        }
      }

      if (executionMap) {
        const statuses: TestExecutionStatus[] = [];
        const ruleStatus = executionMap.get(rule.id);
        if (ruleStatus) statuses.push(ruleStatus);
        for (const testPath of linkedTests) {
          const fileStatus = executionMap.get(testPath);
          if (fileStatus) statuses.push(fileStatus);
        }

        if (statuses.some((s) => s !== "passed")) {
          const nonPassing = statuses.filter((s) => s !== "passed").join(", ");
          violations.push({
            ruleId: rule.id,
            severity: "error",
            filePath: file.path,
            message: `Testes vinculados à regra '${rule.id}' não passaram (status: ${nonPassing}).`
          });
        }
      }
    }
  }

  const hasErrors = violations.some((v) => v.severity === "error");
  const passed = opts.mode === "enforced" ? !hasErrors : true;
  return {
    mode: opts.mode,
    passed,
    checkedRules: approvedRules.length,
    violations
  };
}
