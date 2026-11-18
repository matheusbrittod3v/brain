import type { KnowledgeItem } from "@brain/core";

export interface LivingDocDraft {
  id: string;
  targetItemId: string;
  targetUri: string;
  status: "draft";
  title: string;
  reason: string;
  matchedFiles: string[];
  proposedContent: string;
  authorId?: string;
  createdAt: string;
}

const LIVING_DOC_TYPES = new Set<KnowledgeItem["type"]>([
  "architecture_decision",
  "document",
  "service",
  "api_contract",
  "event_contract"
]);

function matchesFileToItem(filePath: string, item: KnowledgeItem): boolean {
  const normalizedFile = filePath.replace(/\\/g, "/").toLowerCase();
  const segments = new Set(normalizedFile.split("/").filter(Boolean));

  if (item.projectId && segments.has(item.projectId.toLowerCase())) {
    return true;
  }

  if (item.tags.some((tag) => tag.length >= 3 && normalizedFile.includes(tag.toLowerCase()))) {
    return true;
  }

  const metaModule = typeof item.metadata?.module === "string" ? item.metadata.module.toLowerCase() : undefined;
  if (metaModule && normalizedFile.includes(metaModule)) {
    return true;
  }

  const metaPaths = Array.isArray(item.metadata?.paths) ? item.metadata.paths : [];
  if (metaPaths.some((p) => normalizedFile.includes(String(p).replace(/\\/g, "/").toLowerCase()))) {
    return true;
  }

  if (item.sourceUri) {
    const normalizedUri = item.sourceUri.replace(/\\/g, "/").toLowerCase();
    const dir = normalizedUri.split("/").slice(0, -1).join("/");
    if (dir && !dir.startsWith(".brain") && normalizedFile.startsWith(dir)) {
      return true;
    }
  }

  return false;
}

function collectMatchedFiles(changedFiles: readonly string[], item: KnowledgeItem): string[] {
  return changedFiles.filter((file) => matchesFileToItem(file, item));
}

/**
 * Sugere atualizações de documentação viva (ADRs e artefatos arquiteturais)
 * correlacionando arquivos alterados com módulos, projetos, tags e paths rastreados.
 */
export function suggestLivingDocUpdates(changedFiles: readonly string[], items: readonly KnowledgeItem[]): string[] {
  const suggestions: string[] = [];
  for (const item of items) {
    if (!LIVING_DOC_TYPES.has(item.type) || item.status === "deprecated" || item.status === "superseded") {
      continue;
    }
    const matched = collectMatchedFiles(changedFiles, item);
    for (const file of matched) {
      suggestions.push(
        `Revisar ${item.type} '${item.id}' (${item.sourceUri || item.title}) após alteração em '${file}'.`
      );
    }
  }
  return [...new Set(suggestions)];
}

/**
 * Orquestra propostas de atualização de documentação viva em estado 'draft'
 * para revisão humana ou aprovação via workflow.
 */
export function orchestrateLivingDocDrafts(opts: {
  changedFiles: readonly string[];
  items: readonly KnowledgeItem[];
  diffSummary?: string;
  authorId?: string;
  now?: Date;
}): LivingDocDraft[] {
  const createdAt = (opts.now ?? new Date()).toISOString();
  const drafts: LivingDocDraft[] = [];

  for (const item of opts.items) {
    if (!LIVING_DOC_TYPES.has(item.type) || item.status === "deprecated" || item.status === "superseded") {
      continue;
    }

    const matchedFiles = collectMatchedFiles(opts.changedFiles, item);
    if (matchedFiles.length === 0) continue;

    const summaryNote = opts.diffSummary ? `\n\nResumo das alterações: ${opts.diffSummary}` : "";
    drafts.push({
      id: `DRAFT-${item.id}`,
      targetItemId: item.id,
      targetUri: item.sourceUri || `.brain/03-architecture/${item.id}.md`,
      status: "draft",
      title: `Atualização sugerida para ${item.id}: ${item.title}`,
      reason: `Arquivos alterados (${matchedFiles.join(", ")}) impactam o escopo de '${item.id}'.`,
      matchedFiles,
      proposedContent:
        `${item.content}\n\n## Atualização Pendente (Living Doc Draft)\n` +
        `- Arquivos alterados: ${matchedFiles.join(", ")}` +
        summaryNote,
      ...(opts.authorId ? { authorId: opts.authorId } : {}),
      createdAt
    });
  }

  return drafts;
}

/**
 * Versão assíncrona de orquestração que utiliza análise de diff por LLM quando configurada,
 * mantendo fallback determinístico se o provedor de LLM não estiver disponível.
 */
export async function orchestrateLivingDocDraftsWithLlm(opts: {
  changedFiles: readonly string[];
  items: readonly KnowledgeItem[];
  diffSummary?: string;
  authorId?: string;
  now?: Date;
  analyzeDiffWithLlm?: (input: { item: KnowledgeItem; matchedFiles: string[]; diffSummary?: string }) => Promise<string>;
}): Promise<LivingDocDraft[]> {
  const drafts = orchestrateLivingDocDrafts(opts);
  if (!opts.analyzeDiffWithLlm) return drafts;
  const itemById = new Map(opts.items.map((item) => [item.id, item]));
  return Promise.all(
    drafts.map(async (draft) => {
      const item = itemById.get(draft.targetItemId);
      if (!item) return draft;
      try {
        const llmSummary = await opts.analyzeDiffWithLlm!({
          item,
          matchedFiles: draft.matchedFiles,
          diffSummary: opts.diffSummary
        });
        if (!llmSummary.trim()) return draft;
        return {
          ...draft,
          proposedContent: `${item.content}\n\n## Atualização sugerida (LLM diff-analysis)\n${llmSummary.trim()}`
        };
      } catch {
        return draft;
      }
    })
  );
}
