import { getEncoding } from "js-tiktoken";
import type { KnowledgeItem } from "@brain/core";

let cachedEncoder: ReturnType<typeof getEncoding> | undefined;

export function countTokens(text: string): number {
  cachedEncoder ??= getEncoding("cl100k_base");
  return cachedEncoder.encode(text).length;
}

export function fitItemsToTokenBudget(
  items: readonly KnowledgeItem[],
  tokenBudget: number,
  options: { preferFullContent?: boolean } = {}
): { selected: Array<{ item: KnowledgeItem; snippet: string; tokens: number }>; usedTokens: number; effectiveBudget: number } {
  const effectiveBudget = Math.floor(tokenBudget * 0.9);
  const selected: Array<{ item: KnowledgeItem; snippet: string; tokens: number }> = [];
  let usedTokens = 0;

  for (const item of items) {
    let snippet = options.preferFullContent ? item.content : (item.summary ?? item.content.slice(0, 320));
    let tokens = countTokens(`${item.id} ${item.title} ${snippet}`);
    if (usedTokens + tokens > effectiveBudget) {
      snippet = item.summary
        ? options.preferFullContent
          ? `${item.summary.slice(0, 120)} (Ver ${item.sourceUri})`
          : item.summary.slice(0, 120)
        : `Ver ${item.sourceUri}`;
      tokens = countTokens(`${item.id} ${item.title} ${snippet}`);
      if (usedTokens + tokens > effectiveBudget) {
        if (!options.preferFullContent) continue;
        snippet = `Ver ${item.sourceUri}`;
        tokens = countTokens(`${item.id} ${item.title} ${snippet}`);
        if (usedTokens + tokens > effectiveBudget) continue;
      }
    }
    usedTokens += tokens;
    selected.push({ item, snippet, tokens });
  }

  return { selected, usedTokens, effectiveBudget };
}

