import type { KnowledgeItem } from "@brain/core";

export interface StructuredBusinessRule {
  id: string;
  title: string;
  status: KnowledgeItem["status"];
  priority: "low" | "medium" | "high" | "critical";
  conditions: string[];
  effects: string[];
  exceptions: string[];
}

export type RuleComplianceStatus = "compliant" | "violated" | "exempted" | "inactive";

export interface RuleEvaluationReason {
  code:
    | "CONDITION_MET"
    | "CONDITION_MISSING"
    | "EFFECT_APPLIED"
    | "EFFECT_MISSING"
    | "EXCEPTION_TRIGGERED"
    | "RULE_INACTIVE";
  subject: string;
  message: string;
}

export interface RuleEvaluationContext {
  satisfiedConditions?: ReadonlySet<string> | readonly string[];
  observedEffects?: ReadonlySet<string> | readonly string[];
  activeExceptions?: ReadonlySet<string> | readonly string[];
  includeInactive?: boolean;
}

export interface RuleEvaluationResult {
  ruleId: string;
  title: string;
  priority: StructuredBusinessRule["priority"];
  status: RuleComplianceStatus;
  compliant: boolean;
  allowed: boolean;
  satisfiedConditions: string[];
  missingConditions: string[];
  appliedEffects: string[];
  missingEffects: string[];
  triggeredExceptions: string[];
  reasons: RuleEvaluationReason[];
}

export interface BatchRuleEvaluationReport {
  results: RuleEvaluationResult[];
  violations: RuleEvaluationResult[];
  compliantCount: number;
  violatedCount: number;
  exemptedCount: number;
  inactiveCount: number;
}

function toStringSet(input?: ReadonlySet<string> | readonly string[]): ReadonlySet<string> {
  if (!input) return new Set<string>();
  return input instanceof Set ? input : new Set(input);
}

export function extractStructuredRule(item: KnowledgeItem): StructuredBusinessRule {
  const meta = item.metadata ?? {};
  const toStrArray = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
  const rawPriority = String(meta.priority ?? "medium");
  const priority = (["low", "medium", "high", "critical"].includes(rawPriority)
    ? rawPriority
    : "medium") as StructuredBusinessRule["priority"];

  return {
    id: item.id,
    title: item.title,
    status: item.status,
    priority,
    conditions: toStrArray(meta.conditions),
    effects: toStrArray(meta.effects),
    exceptions: toStrArray(meta.exceptions)
  };
}

export function evaluateRulePreconditions(
  rule: StructuredBusinessRule,
  satisfiedConditions: ReadonlySet<string>,
  activeExceptions: ReadonlySet<string> = new Set()
): { allowed: boolean; missingConditions: string[]; triggeredExceptions: string[] } {
  const missingConditions = rule.conditions.filter((c) => !satisfiedConditions.has(c));
  const triggeredExceptions = rule.exceptions.filter((e) => activeExceptions.has(e));
  return {
    allowed: missingConditions.length === 0 && triggeredExceptions.length === 0,
    missingConditions,
    triggeredExceptions
  };
}

/**
 * Deterministically evaluates a structured business rule's conditions, effects, and exceptions,
 * returning structured violation and compliance reasons.
 */
export function evaluateBusinessRule(
  itemOrRule: KnowledgeItem | StructuredBusinessRule,
  context: RuleEvaluationContext = {}
): RuleEvaluationResult {
  const rule =
    "content" in itemOrRule ? extractStructuredRule(itemOrRule) : itemOrRule;

  if (rule.status !== "approved" && !context.includeInactive) {
    return {
      ruleId: rule.id,
      title: rule.title,
      priority: rule.priority,
      status: "inactive",
      compliant: true,
      allowed: false,
      satisfiedConditions: [],
      missingConditions: [],
      appliedEffects: [],
      missingEffects: [],
      triggeredExceptions: [],
      reasons: [
        {
          code: "RULE_INACTIVE",
          subject: rule.id,
          message: `Rule '${rule.id}' is '${rule.status}' and not active for enforcement.`
        }
      ]
    };
  }

  const satisfiedSet = toStringSet(context.satisfiedConditions);
  const exceptionSet = toStringSet(context.activeExceptions);
  const hasObservedEffects = context.observedEffects !== undefined;
  const observedEffectsSet = toStringSet(context.observedEffects);

  const satisfiedConditions = rule.conditions.filter((c) => satisfiedSet.has(c));
  const missingConditions = rule.conditions.filter((c) => !satisfiedSet.has(c));
  const triggeredExceptions = rule.exceptions.filter((e) => exceptionSet.has(e));

  const appliedEffects = hasObservedEffects
    ? rule.effects.filter((ef) => observedEffectsSet.has(ef))
    : [];
  const missingEffects = hasObservedEffects
    ? rule.effects.filter((ef) => !observedEffectsSet.has(ef))
    : [];

  const reasons: RuleEvaluationReason[] = [];

  for (const cond of satisfiedConditions) {
    reasons.push({
      code: "CONDITION_MET",
      subject: cond,
      message: `Condition '${cond}' is satisfied.`
    });
  }
  for (const cond of missingConditions) {
    reasons.push({
      code: "CONDITION_MISSING",
      subject: cond,
      message: `Required condition '${cond}' is not satisfied.`
    });
  }
  for (const exc of triggeredExceptions) {
    reasons.push({
      code: "EXCEPTION_TRIGGERED",
      subject: exc,
      message: `Rule exception '${exc}' was triggered.`
    });
  }
  for (const eff of appliedEffects) {
    reasons.push({
      code: "EFFECT_APPLIED",
      subject: eff,
      message: `Expected effect '${eff}' was observed.`
    });
  }
  for (const eff of missingEffects) {
    reasons.push({
      code: "EFFECT_MISSING",
      subject: eff,
      message: `Expected effect '${eff}' was not observed.`
    });
  }

  let status: RuleComplianceStatus;
  let allowed: boolean;
  let compliant: boolean;

  if (triggeredExceptions.length > 0) {
    status = "exempted";
    allowed = false;
    compliant = true;
  } else if (missingConditions.length > 0 || missingEffects.length > 0) {
    status = "violated";
    allowed = false;
    compliant = false;
  } else {
    status = "compliant";
    allowed = true;
    compliant = true;
  }

  return {
    ruleId: rule.id,
    title: rule.title,
    priority: rule.priority,
    status,
    compliant,
    allowed,
    satisfiedConditions,
    missingConditions,
    appliedEffects,
    missingEffects,
    triggeredExceptions,
    reasons
  };
}

export function evaluateBusinessRules(
  itemsOrRules: readonly (KnowledgeItem | StructuredBusinessRule)[],
  context: RuleEvaluationContext = {}
): BatchRuleEvaluationReport {
  const results = itemsOrRules
    .filter((entry) => !("content" in entry) || entry.type === "business_rule")
    .map((entry) => evaluateBusinessRule(entry, context));

  const violations = results.filter((r) => r.status === "violated");
  return {
    results,
    violations,
    compliantCount: results.filter((r) => r.status === "compliant").length,
    violatedCount: violations.length,
    exemptedCount: results.filter((r) => r.status === "exempted").length,
    inactiveCount: results.filter((r) => r.status === "inactive").length
  };
}
