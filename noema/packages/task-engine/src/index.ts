import type { KnowledgeItem } from "@noema/core";

export type TaskPriority = "critical" | "high" | "medium" | "low";
export type TaskKind = "epic" | "story" | "task";

export interface PlannedTask {
  id: string;
  kind: TaskKind;
  step: number;
  title: string;
  description: string;
  priority: TaskPriority;
  priorityScore: number;
  targetFiles: string[];
  relatedRuleIds: string[];
  acceptanceCriteria: string[];
  dependencies: string[];
}

export interface PlanTasksOptions {
  requirements?: readonly KnowledgeItem[];
  impactedRuleIds?: readonly string[];
  uncoveredRuleIds?: readonly string[];
  targetFiles?: readonly string[];
}

const PRIORITY_SCORES: Record<TaskPriority, number> = {
  critical: 100,
  high: 75,
  medium: 50,
  low: 25
};

function resolvePriority(item?: KnowledgeItem): TaskPriority {
  if (!item) return "medium";
  const raw = String(item.metadata?.priority ?? item.metadata?.severity ?? "").toLowerCase();
  if (raw === "critical" || item.tags.some((t) => t.toLowerCase() === "critical")) return "critical";
  if (raw === "high" || item.tags.some((t) => t.toLowerCase() === "high")) return "high";
  if (raw === "low" || item.tags.some((t) => t.toLowerCase() === "low")) return "low";
  return "medium";
}

function extractAcceptanceCriteria(item: KnowledgeItem): string[] {
  const ac = item.metadata?.acceptanceCriteria;
  if (Array.isArray(ac)) {
    const cleaned = ac.map((x) => String(x).trim()).filter(Boolean);
    if (cleaned.length > 0) return cleaned;
  } else if (typeof ac === "string" && ac.trim().length > 0) {
    return [ac.trim()];
  }
  return [`Garantir conformidade com ${item.id} (${item.title}).`];
}

function extractTargetFiles(item: KnowledgeItem, fallback: readonly string[]): string[] {
  const metaFiles = item.metadata?.targetFiles;
  if (Array.isArray(metaFiles) && metaFiles.length > 0) {
    return metaFiles.map((f) => String(f));
  }
  if (item.sourceUri && item.sourceUri.trim().length > 0) {
    return [item.sourceUri];
  }
  return [...fallback];
}

/**
 * Planeja épicos, histórias e tarefas ordenadas por prioridade e dependências
 * a partir de requisitos, regras impactadas e lacunas de cobertura de testes.
 */
export function planAutonomousTasks(
  epicDescription: string,
  rules: readonly KnowledgeItem[],
  options: PlanTasksOptions = {}
): PlannedTask[] {
  const impactedSet = new Set(options.impactedRuleIds ?? []);
  const uncoveredSet = new Set(options.uncoveredRuleIds ?? []);
  const requirements = options.requirements ?? [];
  const defaultTargets = options.targetFiles && options.targetFiles.length > 0 ? options.targetFiles : ["src/"];

  const activeRules = rules.filter((r) => r.status !== "deprecated" && r.status !== "superseded");
  const scopedRules =
    impactedSet.size > 0
      ? activeRules.filter((r) => impactedSet.has(r.id) || uncoveredSet.has(r.id))
      : activeRules;

  const allRuleIds = [...new Set([...scopedRules.map((r) => r.id), ...uncoveredSet])];
  const rulePriorities = scopedRules.map((r) => PRIORITY_SCORES[resolvePriority(r)]);
  const maxPriorityScore = rulePriorities.length > 0 ? Math.max(...rulePriorities) : PRIORITY_SCORES.medium;
  const epicPriority: TaskPriority =
    maxPriorityScore >= 100 ? "critical" : maxPriorityScore >= 75 ? "high" : maxPriorityScore >= 50 ? "medium" : "low";

  const tasks: PlannedTask[] = [];
  const epicId = "EPIC-1";

  tasks.push({
    id: epicId,
    kind: "epic",
    step: 1,
    title: `Épico: ${epicDescription}`,
    description: epicDescription,
    priority: epicPriority,
    priorityScore: maxPriorityScore,
    targetFiles: [".brain/01-business/", ".brain/03-architecture/"],
    relatedRuleIds: allRuleIds,
    acceptanceCriteria: [
      `Todas as regras impactadas (${allRuleIds.join(", ") || "N/A"}) implementadas com âncoras @brain-rule.`,
      "Todos os Guardians (architecture-guardian e business-rule-guardian) aprovados em modo enforced."
    ],
    dependencies: []
  });

  // Histórias a partir de requisitos (ou história padrão de análise de contratos)
  const storyIds: string[] = [];
  if (requirements.length > 0) {
    const sortedReqs = [...requirements].sort(
      (a, b) => PRIORITY_SCORES[resolvePriority(b)] - PRIORITY_SCORES[resolvePriority(a)]
    );
    sortedReqs.forEach((req, idx) => {
      const storyId = `STORY-${idx + 1}`;
      storyIds.push(storyId);
      const priority = resolvePriority(req);
      tasks.push({
        id: storyId,
        kind: "story",
        step: 0,
        title: `História: ${req.title}`,
        description: req.content,
        priority,
        priorityScore: PRIORITY_SCORES[priority],
        targetFiles: extractTargetFiles(req, [".brain/01-business/"]),
        relatedRuleIds: req.relatedIds.length > 0 ? [...req.relatedIds] : allRuleIds,
        acceptanceCriteria: extractAcceptanceCriteria(req),
        dependencies: [epicId]
      });
    });
  } else {
    const storyId = "STORY-1";
    storyIds.push(storyId);
    tasks.push({
      id: storyId,
      kind: "story",
      step: 0,
      title: `Validar impacto e contratos para: ${epicDescription}`,
      description: `Analisar contratos e regras aplicáveis ao épico '${epicDescription}'.`,
      priority: epicPriority,
      priorityScore: maxPriorityScore,
      targetFiles: [".brain/01-business/", ".brain/03-architecture/"],
      relatedRuleIds: allRuleIds,
      acceptanceCriteria: ["Contratos de API/domínio e regras de negócio validados antes da implementação."],
      dependencies: [epicId]
    });
  }

  const defaultStoryDep = storyIds[0]!;

  // Tarefas de implementação ordenadas por prioridade
  const sortedRules = [...scopedRules].sort((a, b) => {
    const scoreA =
      PRIORITY_SCORES[resolvePriority(a)] + (impactedSet.has(a.id) ? 10 : 0) + (uncoveredSet.has(a.id) ? 5 : 0);
    const scoreB =
      PRIORITY_SCORES[resolvePriority(b)] + (impactedSet.has(b.id) ? 10 : 0) + (uncoveredSet.has(b.id) ? 5 : 0);
    return scoreB - scoreA;
  });

  const implTaskByRuleId = new Map<string, string>();
  sortedRules.forEach((rule, idx) => {
    const taskId = `TASK-IMPL-${idx + 1}`;
    implTaskByRuleId.set(rule.id, taskId);
    const priority = resolvePriority(rule);
    const score =
      PRIORITY_SCORES[priority] + (impactedSet.has(rule.id) ? 10 : 0) + (uncoveredSet.has(rule.id) ? 5 : 0);
    const matchingStory = tasks.find(
      (t) => t.kind === "story" && t.relatedRuleIds.includes(rule.id)
    )?.id ?? defaultStoryDep;

    tasks.push({
      id: taskId,
      kind: "task",
      step: 0,
      title: `Implementar ${rule.id}: ${rule.title}`,
      description: rule.content,
      priority,
      priorityScore: score,
      targetFiles: extractTargetFiles(rule, defaultTargets),
      relatedRuleIds: [rule.id],
      acceptanceCriteria: [
        ...extractAcceptanceCriteria(rule),
        `Código anotado com âncora '// @brain-rule ${rule.id}'.`
      ],
      dependencies: [matchingStory]
    });
  });

  // Tarefas de cobertura de testes para regras descobertas
  const uncoveredRulesList =
    uncoveredSet.size > 0
      ? [...uncoveredSet]
      : sortedRules.filter((r) => r.metadata?.verified !== true).map((r) => r.id);

  if (uncoveredRulesList.length > 0) {
    const ruleMap = new Map(activeRules.map((r) => [r.id, r]));
    const sortedUncovered = [...uncoveredRulesList].sort((a, b) => {
      const scoreA = PRIORITY_SCORES[resolvePriority(ruleMap.get(a))];
      const scoreB = PRIORITY_SCORES[resolvePriority(ruleMap.get(b))];
      return scoreB - scoreA;
    });

    sortedUncovered.forEach((ruleId, idx) => {
      const rule = ruleMap.get(ruleId);
      const priority = resolvePriority(rule);
      const implDep = implTaskByRuleId.get(ruleId);
      tasks.push({
        id: `TASK-TEST-${idx + 1}`,
        kind: "task",
        step: 0,
        title: `Adicionar teste VERIFIED_BY para ${ruleId}`,
        description: `Criar e executar teste automatizado cobrindo a regra '${ruleId}'.`,
        priority,
        priorityScore: PRIORITY_SCORES[priority] + 5,
        targetFiles: ["test/"],
        relatedRuleIds: [ruleId],
        acceptanceCriteria: [
          `Teste contém âncora '@brain-rule ${ruleId}' (relação VERIFIED_BY).`,
          "Execução do teste passa sem falhas no CI."
        ],
        dependencies: implDep ? [implDep] : [defaultStoryDep]
      });
    });
  }

  return tasks.map((task, index) => ({
    ...task,
    step: index + 1
  }));
}
