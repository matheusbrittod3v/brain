import mammoth from "mammoth";
import TurndownService from "turndown";
import { extractText } from "unpdf";

export const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
export const MAX_DOCUMENT_BASE64_CHARS = 4 * Math.ceil(MAX_DOCUMENT_BYTES / 3);
export const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".html", ".htm", ".csv", ".md", ".txt", ".json"]);

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced"
});

/**
 * Parses uploaded documents (PDF, DOCX, HTML, CSV, Markdown, TXT) directly in TypeScript.
 */
export async function parseDocumentBase64(
  fileName: string,
  contentBase64: string
): Promise<{ markdown: string; engine: "unpdf" | "mammoth" | "turndown" | "text" }> {
  const safeName = fileName.trim();
  if (!safeName || safeName.includes("..") || safeName.includes("/") || safeName.includes("\\")) {
    throw new Error("Nome de arquivo inválido ou inseguro.");
  }

  const ext = safeName.slice(safeName.lastIndexOf(".")).toLowerCase();
  if (!DOCUMENT_EXTENSIONS.has(ext)) {
    throw new Error(`Extensão não suportada: ${ext}`);
  }

  const buffer = Buffer.from(contentBase64, "base64");
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error("Tamanho do documento fora dos limites permitidos (máx 16 MiB).");
  }

  if (ext === ".pdf") {
    const { text } = await extractText(new Uint8Array(buffer), { mergePages: true });
    const markdown = (Array.isArray(text) ? text.join("\n\n") : String(text)).trim();
    if (!markdown) throw new Error("Não foi possível extrair texto do PDF.");
    return { markdown, engine: "unpdf" };
  }

  if (ext === ".docx") {
    const result = await mammoth.convertToHtml({ buffer });
    const markdown = turndown.turndown(result.value).trim();
    if (!markdown) throw new Error("Documento DOCX vazio ou ilegível.");
    return { markdown, engine: "mammoth" };
  }

  if (ext === ".html" || ext === ".htm") {
    const html = buffer.toString("utf8");
    const markdown = turndown.turndown(html).trim();
    return { markdown, engine: "turndown" };
  }

  // .md, .txt, .csv, .json
  const text = buffer.toString("utf8").trim();
  if (!text) throw new Error("Documento textual vazio.");
  return { markdown: ext === ".json" ? `\`\`\`json\n${text}\n\`\`\`` : text, engine: "text" };
}

