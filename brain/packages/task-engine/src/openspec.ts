import type { TaskPriority } from "./index.js";

export interface ParsedChecklistTask {
  id: string;
  index: number;
  section: string;
  title: string;
  completed: boolean;
  priority: TaskPriority;
}

/**
 * Parses OpenSpec-style markdown checklists (`- [ ] ...` / `- [x] ...`)
 * grouped under `##` / `###` headings into structured tasks for the Brain Runner.
 */
export function parseSpecTasksChecklist(markdown: string): ParsedChecklistTask[] {
  const lines = markdown.split(/\r?\n/);
  let currentSection = "Geral";
  const tasks: ParsedChecklistTask[] = [];
  let idx = 0;

  for (const rawLine of lines) {
    const headingMatch = rawLine.match(/^#{2,4}\s+(.+)$/);
    if (headingMatch) {
      currentSection = headingMatch[1]!.trim();
      continue;
    }

    const taskMatch = rawLine.match(/^\s*[-*]\s+\[([ xX])\]\s+(.+)$/);
    if (!taskMatch) continue;

    idx += 1;
    const completed = taskMatch[1]!.toLowerCase() === "x";
    const title = taskMatch[2]!.trim();
    const lower = title.toLowerCase();
    const priority: TaskPriority = /\b(critical|p0|blocker|security)\b/.test(lower)
      ? "critical"
      : /\b(high|p1|urgent)\b/.test(lower)
        ? "high"
        : /\b(low|p3|optional)\b/.test(lower)
          ? "low"
          : "medium";

    tasks.push({
      id: `SPEC-TASK-${idx}`,
      index: idx,
      section: currentSection,
      title,
      completed,
      priority
    });
  }

  return tasks;
}

export interface SpecDeltaSummary {
  specId: string;
  addedLines: string[];
  removedLines: string[];
  hasChanges: boolean;
}

/**
 * Builds an OpenSpec-style delta summary between two revisions of a Spec.
 */
export function buildSpecDeltaProposal(specId: string, previousContent: string, nextContent: string): SpecDeltaSummary {
  const prevLines = previousContent.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const nextLines = nextContent.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const prevSet = new Set(prevLines);
  const nextSet = new Set(nextLines);

  const addedLines = nextLines.filter((l) => !prevSet.has(l));
  const removedLines = prevLines.filter((l) => !nextSet.has(l));

  return {
    specId,
    addedLines,
    removedLines,
    hasChanges: addedLines.length > 0 || removedLines.length > 0
  };
}

