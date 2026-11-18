const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CPF_RE = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const CREDIT_CARD_RE = /\b(?:\d[ -]*?){13,16}\b/g;
const PHONE_RE = /\b(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)?(?:9\d{4}|\d{4})-?\d{4}\b/g;

/**
 * Sanitizes PII (Emails, CPFs, Credit Cards, Phones) directly in TypeScript without external Python dependencies.
 */
export function redactPii(text: string): string {
  if (!text) return text;
  return text
    .replace(EMAIL_RE, "[EMAIL_REDACTED]")
    .replace(CPF_RE, "[CPF_REDACTED]")
    .replace(CREDIT_CARD_RE, (match) => {
      const digits = match.replace(/\D/g, "");
      return digits.length >= 13 && digits.length <= 16 ? "[CARD_REDACTED]" : match;
    })
    .replace(PHONE_RE, "[PHONE_REDACTED]");
}

export function rerankPassages<T extends { id: string; title: string; content: string }>(
  query: string,
  items: T[]
): T[] {
  if (items.length <= 1 || !query.trim()) return items;
  const queryTerms = new Set(
    query
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 1)
  );
  if (queryTerms.size === 0) return items;

  return [...items]
    .map((item) => {
      const text = `${item.title} ${item.content}`.toLowerCase();
      const docTerms = new Set(text.split(/\W+/).filter((w) => w.length > 1));
      let overlap = 0;
      for (const term of queryTerms) {
        if (docTerms.has(term)) overlap += 1;
      }
      const titleBoost = item.title.toLowerCase().includes(query.toLowerCase()) ? 0.5 : 0;
      const score = overlap / queryTerms.size + titleBoost;
      return { item, score };
    })
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

