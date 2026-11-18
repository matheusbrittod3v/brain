import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractCodeSymbols } from "@brain/code-intelligence";
import { getEncoding } from "js-tiktoken";
import ts from "typescript";

export * from "./pii.js";
export * from "./document-parser.js";
export * from "./git-github.js";
export * from "./url-extractor.js";

const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: "AWS Access Key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "GitHub Token", regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: "Private Key PEM", regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  { name: "Database Connection String", regex: /\b(?:postgres|mysql|mongodb):\/\/[^:\s]+:[^@\s]+@/i },
  { name: "Generic Bearer JWT", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ }
];

let cachedEncoder: ReturnType<typeof getEncoding> | undefined;
function getTokenEncoder() {
  cachedEncoder ??= getEncoding("cl100k_base");
  return cachedEncoder;
}

export interface SecretScanResult {
  clean: boolean;
  findings: string[];
  ignoredFindings: string[];
  engine: "gitleaks" | "regex" | "unavailable";
}

export type GitleaksRunner = (content: string) => void;

export function loadBrainIgnoreSecrets(ignoreFilePath = ".brainignore-secrets"): string[] {
  if (!existsSync(ignoreFilePath)) return [];
  return readFileSync(ignoreFilePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function scanForSecrets(
  content: string,
  options: {
    ignoreRules?: string[];
    ignoreFilePath?: string;
    useGitleaks?: boolean;
    gitleaksRunner?: GitleaksRunner;
  } = {}
): SecretScanResult {
  const ignoreRules = options.ignoreRules ?? (options.ignoreFilePath ? loadBrainIgnoreSecrets(options.ignoreFilePath) : []);
  const rawFindings = new Set<string>(
    SECRET_PATTERNS.filter((p) => p.regex.test(content)).map((p) => p.name)
  );
  const useGitleaks = options.useGitleaks ?? true;
  let engine: SecretScanResult["engine"] = useGitleaks ? "gitleaks" : "regex";

  if (useGitleaks) {
    let dir: string | undefined;
    try {
      if (options.gitleaksRunner) {
        options.gitleaksRunner(content);
      } else {
        dir = mkdtempSync(join(tmpdir(), "brain-gl-"));
        writeFileSync(join(dir, "payload.txt"), content, "utf8");
        execFileSync("gitleaks", ["detect", "--no-git", "--source", dir, "--exit-code", "1"], {
          stdio: "ignore",
          timeout: 5000
        });
      }
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 1) {
        rawFindings.add("Gitleaks Secret Match");
      } else {
        engine = "unavailable";
        rawFindings.add("Gitleaks Scanner Failure");
      }
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  const all = [...rawFindings];
  const ignoredFindings = all.filter((f) => f !== "Gitleaks Scanner Failure" && ignoreRules.includes(f));
  const findings = all.filter((f) => f === "Gitleaks Scanner Failure" || !ignoreRules.includes(f));
  return { clean: findings.length === 0, findings, ignoredFindings, engine };
}

/**
 * Isola conteúdo externo não confiável em bloco estruturado contra prompt injection (Item 54).
 */
export function wrapUntrustedContent(content: string): string {
  const sanitized = content.replace(/<\/?external_data[^>]*>/gi, "");
  return `<external_data trust="untrusted">\n${sanitized}\n</external_data>`;
}

export interface TextChunk {
  index: number;
  text: string;
  breadcrumb?: string;
  tokenCount?: number;
  symbolName?: string;
}

/**
 * Chunking hierárquico por seção Markdown (H2/H3) com janela de 512 tokens e overlap de 64 tokens.
 */
export function chunkMarkdown(markdown: string, maxTokens = 512, overlapTokens = 64): TextChunk[] {
  const enc = getTokenEncoder();
  const lines = markdown.split(/\r?\n/);
  let currentH1 = "";
  const sections: Array<{ breadcrumb: string; body: string }> = [];
  let buf: string[] = [];
  let currentHeader = "";

  for (const line of lines) {
    if (line.startsWith("# ")) {
      currentH1 = line.trim();
    }
    if (/^#{2,3}\s+/.test(line)) {
      if (buf.length > 0) {
        sections.push({
          breadcrumb: [currentH1, currentHeader].filter(Boolean).join(" > "),
          body: buf.join("\n").trim()
        });
      }
      currentHeader = line.trim();
      buf = [line];
    } else {
      buf.push(line);
    }
  }
  if (buf.length > 0) {
    sections.push({
      breadcrumb: [currentH1, currentHeader].filter(Boolean).join(" > "),
      body: buf.join("\n").trim()
    });
  }

  const chunks: TextChunk[] = [];
  let idx = 0;

  for (const sec of sections) {
    if (!sec.body) continue;
    const fullText = sec.body;
    const tokens = enc.encode(fullText);

    if (tokens.length <= maxTokens) {
      chunks.push({ index: idx++, text: fullText, breadcrumb: sec.breadcrumb || undefined, tokenCount: tokens.length });
      continue;
    }

    const step = Math.max(1, maxTokens - overlapTokens);
    for (let start = 0; start < tokens.length; start += step) {
      const slice = tokens.slice(start, start + maxTokens);
      const text = enc.decode(slice).trim();
      if (text.length > 0) {
        chunks.push({ index: idx++, text, breadcrumb: sec.breadcrumb || undefined, tokenCount: slice.length });
      }
      if (start + maxTokens >= tokens.length) break;
    }
  }
  return chunks;
}

/**
 * Chunking semântico por símbolo AST (até 800 tokens) preservando cabeçalho de imports.
 */
export function chunkCodeByAst(filePath: string, sourceCode: string, maxTokens = 800): TextChunk[] {
  const enc = getTokenEncoder();
  const posixPath = filePath.replace(/\\/g, "/");
  if (!/\.[cm]?[jt]sx?$/.test(posixPath)) {
    return chunkNonTsCodeBySymbols(posixPath, sourceCode, maxTokens, enc);
  }

  const sf = ts.createSourceFile(posixPath, sourceCode, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const blocks: Array<{ name: string; text: string }> = [];

  ts.forEachChild(sf, (node) => {
    if (ts.isImportDeclaration(node)) {
      imports.push(node.getText(sf));
    } else if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isVariableStatement(node)
    ) {
      const name =
        (node as { name?: ts.Identifier }).name?.text ??
        (ts.isVariableStatement(node) ? node.declarationList.declarations[0]?.name.getText(sf) : undefined) ??
        "block";
      blocks.push({ name, text: node.getText(sf) });
    }
  });

  if (blocks.length === 0) {
    const tokens = enc.encode(sourceCode);
    return [{ index: 0, text: sourceCode, tokenCount: tokens.length }];
  }

  const importHeader = imports.join("\n");
  const chunks: TextChunk[] = [];
  let idx = 0;

  for (const b of blocks) {
    const combined = importHeader ? `${importHeader}\n\n${b.text}` : b.text;
    const tokens = enc.encode(combined);
    if (tokens.length <= maxTokens) {
      chunks.push({ index: idx++, text: combined, tokenCount: tokens.length, symbolName: b.name });
    } else {
      for (let start = 0; start < tokens.length; start += maxTokens) {
        const slice = tokens.slice(start, start + maxTokens);
        chunks.push({
          index: idx++,
          text: enc.decode(slice),
          tokenCount: slice.length,
          symbolName: b.name
        });
      }
    }
  }
  return chunks;
}

function sliceTokensIntoChunks(
  text: string,
  maxTokens: number,
  enc: ReturnType<typeof getEncoding>,
  startIndex: number,
  symbolName?: string
): TextChunk[] {
  const tokens = enc.encode(text);
  if (tokens.length <= maxTokens) {
    return [{ index: startIndex, text, tokenCount: tokens.length, ...(symbolName ? { symbolName } : {}) }];
  }
  const out: TextChunk[] = [];
  let idx = startIndex;
  for (let start = 0; start < tokens.length; start += maxTokens) {
    const slice = tokens.slice(start, start + maxTokens);
    const decoded = enc.decode(slice).trim();
    if (decoded.length > 0) {
      out.push({
        index: idx++,
        text: decoded,
        tokenCount: slice.length,
        ...(symbolName ? { symbolName } : {})
      });
    }
  }
  return out;
}

function chunkNonTsCodeBySymbols(
  posixPath: string,
  sourceCode: string,
  maxTokens: number,
  enc: ReturnType<typeof getEncoding>
): TextChunk[] {
  const symbols = extractCodeSymbols(posixPath, sourceCode).sort((a, b) => a.line - b.line);
  if (symbols.length === 0) {
    return sliceTokensIntoChunks(sourceCode, maxTokens, enc, 0);
  }

  const lines = sourceCode.split(/\r?\n/);
  const firstSymbolLine = symbols[0]!.line;
  const headerText = lines
    .slice(0, Math.max(0, firstSymbolLine - 1))
    .join("\n")
    .trim();

  // Build top-level non-overlapping ranges; if a top-level range has nested symbols and exceeds maxTokens, split by them.
  const topLevelRanges: Array<{ name: string; startLine: number; endLine: number }> = [];
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i]!;
    const endLine = sym.endLine ?? (i + 1 < symbols.length ? Math.max(sym.line, symbols[i + 1]!.line - 1) : lines.length);
    const prev = topLevelRanges[topLevelRanges.length - 1];
    if (prev && sym.line >= prev.startLine && sym.line <= prev.endLine) {
      continue;
    }
    topLevelRanges.push({ name: sym.name, startLine: sym.line, endLine });
  }

  const blocks: Array<{ name: string; text: string }> = [];
  for (const range of topLevelRanges) {
    const blockText = lines.slice(range.startLine - 1, range.endLine).join("\n").trim();
    if (!blockText) continue;
    const blockTokens = enc.encode(blockText).length;
    if (blockTokens > maxTokens) {
      const nested = symbols.filter(
        (s) => s.line > range.startLine && s.line <= range.endLine && s.kind !== "route"
      );
      if (nested.length > 0) {
        const prefixText = lines.slice(range.startLine - 1, nested[0]!.line - 1).join("\n").trim();
        if (prefixText) {
          blocks.push({ name: range.name, text: prefixText });
        }
        for (let j = 0; j < nested.length; j++) {
          const nSym = nested[j]!;
          const nEnd = Math.min(
            range.endLine,
            nSym.endLine ?? (j + 1 < nested.length ? nested[j + 1]!.line - 1 : range.endLine)
          );
          const nText = lines.slice(nSym.line - 1, nEnd).join("\n").trim();
          if (nText) blocks.push({ name: nSym.name, text: nText });
        }
        continue;
      }
    }
    blocks.push({ name: range.name, text: blockText });
  }

  if (blocks.length === 0) {
    return sliceTokensIntoChunks(sourceCode, maxTokens, enc, 0);
  }

  const headerPrefix = headerText && enc.encode(headerText).length < Math.floor(maxTokens / 2) ? headerText : "";
  const chunks: TextChunk[] = [];
  let idx = 0;
  let currentBlocks: Array<{ name: string; text: string }> = [];

  const flushGroup = () => {
    if (currentBlocks.length === 0) return;
    const body = currentBlocks.map((b) => b.text).join("\n\n");
    const combined = headerPrefix ? `${headerPrefix}\n\n${body}` : body;
    const symbolName = currentBlocks.map((b) => b.name).join(", ");
    const emitted = sliceTokensIntoChunks(combined, maxTokens, enc, idx, symbolName);
    chunks.push(...emitted);
    idx += emitted.length;
    currentBlocks = [];
  };

  for (const block of blocks) {
    const candidateBody = [...currentBlocks, block].map((b) => b.text).join("\n\n");
    const candidateText = headerPrefix ? `${headerPrefix}\n\n${candidateBody}` : candidateBody;
    if (currentBlocks.length > 0 && enc.encode(candidateText).length > maxTokens) {
      flushGroup();
    }
    currentBlocks.push(block);
  }
  flushGroup();

  return chunks;
}
