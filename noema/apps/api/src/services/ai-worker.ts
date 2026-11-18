import { BrainError } from "@noema/core";
import { parseDocumentBase64, redactPii, rerankPassages, type SecretScanResult } from "@noema/ingestion";

export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
export const MAX_DOCUMENT_BASE64_CHARS = 4 * Math.ceil(MAX_DOCUMENT_BYTES / 3);
export const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".pptx", ".xlsx", ".html", ".htm", ".csv", ".md", ".txt", ".json"]);

export function assertSecretScanClean(scan: SecretScanResult, detectedMessage: string): void {
  if (scan.engine === "unavailable") {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Gitleaks indisponível; a gravação foi bloqueada.", 503);
  }
  if (!scan.clean) {
    throw new BrainError("BRAIN_ERR_POLICY_DENIED", `${detectedMessage}: ${scan.findings.join(", ")}`, 422);
  }
}

export async function redactPiiWithAiWorker(
  text: string,
  aiWorkerUrl = process.env.AI_WORKER_URL,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  if (!aiWorkerUrl) return text;
  let res: Response;
  try {
    res = await fetchFn(`${aiWorkerUrl.replace(/\/$/, "")}/redact-pii`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text })
    });
  } catch {
    throw new BrainError(
      "BRAIN_ERR_STORAGE_UNAVAILABLE",
      "AI Worker indisponível; conteúdo não foi persistido porque a sanitização PII configurada não pôde ser concluída.",
      503
    );
  }
  if (!res.ok) {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", `PII redaction failed: HTTP ${res.status}`, 503);
  }
  let data: { redacted_text?: string };
  try {
    data = (await res.json()) as { redacted_text?: string };
  } catch {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "PII redaction response is invalid JSON", 502);
  }
  if (typeof data.redacted_text !== "string") {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "PII redaction response is missing redacted_text", 502);
  }
  return data.redacted_text;
}

export async function parseDocumentWithAiWorker(
  fileName: string,
  contentBase64: string
): Promise<{ markdown: string; engine: "docling" | "markitdown" | "unpdf" | "mammoth" | "turndown" | "text" }> {
  const aiWorkerUrl = process.env.AI_WORKER_URL;
  if (!aiWorkerUrl) {
    // Native TypeScript document parsing (replaces Python AI Worker)
    try {
      return await parseDocumentBase64(fileName, contentBase64);
    } catch (error) {
      throw new BrainError("BRAIN_ERR_INVALID_INPUT", error instanceof Error ? error.message : String(error), 422);
    }
  }
  let response: Response;
  try {
    response = await fetch(`${aiWorkerUrl.replace(/\/$/, "")}/parse-document`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file_name: fileName, content_base64: contentBase64 }),
      signal: AbortSignal.timeout(120_000)
    });
  } catch {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Docling indisponível; documento não foi persistido.", 503);
  }
  if (response.status === 503) {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Docling indisponível; documento não foi persistido.", 503);
  }
  if (!response.ok) {
    throw new BrainError("BRAIN_ERR_INVALID_INPUT", `Docling rejeitou o documento (HTTP ${response.status}).`, 422);
  }
  let data: { markdown?: unknown; engine?: unknown };
  try {
    data = (await response.json()) as { markdown?: unknown; engine?: unknown };
  } catch {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Resposta do Docling inválida.", 502);
  }
  if ((data.engine !== "docling" && data.engine !== "markitdown") || typeof data.markdown !== "string" || !data.markdown.trim()) {
    throw new BrainError("BRAIN_ERR_STORAGE_UNAVAILABLE", "Resposta do Docling não contém Markdown válido.", 502);
  }
  if (Buffer.byteLength(data.markdown, "utf8") > 8 * 1024 * 1024) {
    throw new BrainError("BRAIN_ERR_INVALID_INPUT", "Documento convertido excede o limite de 8 MiB de Markdown.", 422);
  }
  return { markdown: data.markdown, engine: data.engine };
}

export async function rerankWithAiWorker<T extends { id: string; title: string; content: string }>(
  query: string,
  items: T[],
  aiWorkerUrl = process.env.AI_WORKER_URL
): Promise<T[]> {
  if (items.length <= 1) return items;
  if (!aiWorkerUrl) {
    return rerankPassages(query, items);
  }
  try {
    const res = await fetch(`${aiWorkerUrl.replace(/\/$/, "")}/rerank`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query,
        documents: items.map((item) => ({ id: item.id, text: `${item.title}\n${item.content}` }))
      })
    });
    if (!res.ok) return items;
    const data = (await res.json()) as { results?: Array<{ id: string; score?: number }>; ranked_ids?: string[] };
    const orderedIds = data.ranked_ids ?? data.results?.map((r) => r.id);
    if (!orderedIds || orderedIds.length === 0) return items;
    const byId = new Map(items.map((item) => [item.id, item]));
    const reranked: T[] = [];
    for (const id of orderedIds) {
      const found = byId.get(id);
      if (found) {
        reranked.push(found);
        byId.delete(id);
      }
    }
    for (const remaining of byId.values()) {
      reranked.push(remaining);
    }
    return reranked;
  } catch {
    return items;
  }
}

