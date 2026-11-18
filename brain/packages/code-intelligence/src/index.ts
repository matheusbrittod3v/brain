import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fromBinary } from "@bufbuild/protobuf";
import { IndexSchema, SymbolRole, type Index as ProtoScipIndex, type Occurrence as ProtoScipOccurrence } from "@scip-code/scip";
import ts from "typescript";
import { Parser, Language } from "web-tree-sitter";

export * from "./tree-sitter.js";

const execFileAsync = promisify(execFile);

export interface CodeAnchor {
  kind: "brain-rule" | "brain-adr";
  targetId: string;
  relationType: "GOVERNED_BY" | "DECIDED_BY" | "VERIFIED_BY";
  filePath: string;
  line: number;
  isInferred: false;
  confidence: 1.0;
}

const ANCHOR_REGEX = /@(brain-rule|brain-adr)\s+([A-Za-z0-9_-]+)/g;

export function extractCodeAnchors(filePath: string, sourceCode: string): CodeAnchor[] {
  const posixPath = filePath.replace(/\\/g, "/");
  const isTestFile = /\.(spec|test)\.[cm]?[jt]sx?$|_test\.py$/.test(posixPath);
  const lines = sourceCode.split(/\r?\n/);
  const anchors: CodeAnchor[] = [];

  lines.forEach((lineText, idx) => {
    let match: RegExpExecArray | null;
    ANCHOR_REGEX.lastIndex = 0;
    while ((match = ANCHOR_REGEX.exec(lineText)) !== null) {
      const kind = match[1] as "brain-rule" | "brain-adr";
      const targetId = match[2];
      const relationType =
        kind === "brain-adr"
          ? "DECIDED_BY"
          : isTestFile
            ? "VERIFIED_BY"
            : "GOVERNED_BY";

      anchors.push({
        kind,
        targetId,
        relationType,
        filePath: posixPath,
        line: idx + 1,
        isInferred: false,
        confidence: 1.0
      });
    }
  });

  return anchors;
}

export interface CodeSymbol {
  name: string;
  kind: "function" | "method" | "class" | "interface" | "route";
  filePath: string;
  line: number;
  endLine?: number;
}

export interface ExtractCodeSymbolsOptions {
  treeSitterParser?: Parser;
}

interface PatternSpec {
  kind: CodeSymbol["kind"];
  regex: RegExp;
}

const ROUTE_REGEX = /\.(?:get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/i;
const PYTHON_ROUTE_REGEX = /@(?:app|router|bp|blueprint)\.(?:get|post|put|patch|delete|route)\(\s*["'`]([^"'`]+)["'`]/i;
const GO_ROUTE_REGEX = /\.(?:GET|POST|PUT|PATCH|DELETE|HandleFunc|Handle|Get|Post|Put|Patch|Delete)\(\s*["'`]([^"'`]+)["'`]/;
const JAVA_ROUTE_REGEX = /@(?:Get|Post|Put|Patch|Delete|Request)Mapping\(\s*(?:value\s*=\s*)?["']([^"']+)["']/;
const RUST_ROUTE_REGEX = /#\[(?:get|post|put|patch|delete)\(\s*["']([^"']+)["']\s*\)\]|\.route\(\s*["']([^"']+)["']/;

const GENERIC_PATTERNS: PatternSpec[] = [
  { kind: "function", regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/ },
  { kind: "function", regex: /^\s*(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/ },
  { kind: "function", regex: /^\s*func\s+([A-Za-z0-9_]+)\s*\(/ },
  { kind: "method", regex: /^\s*func\s+\([^)]+\)\s+([A-Za-z0-9_]+)\s*\(/ },
  { kind: "class", regex: /^\s*(?:export\s+)?class\s+([A-Za-z0-9_]+)/ },
  { kind: "interface", regex: /^\s*(?:export\s+)?interface\s+([A-Za-z0-9_]+)/ },
  { kind: "route", regex: ROUTE_REGEX }
];

function computeBraceBlockEndLine(lines: string[], startIdx: number): number {
  let depth = 0;
  let seenBrace = false;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]!;
    for (const ch of line) {
      if (ch === "{") {
        depth++;
        seenBrace = true;
      } else if (ch === "}") {
        depth--;
        if (seenBrace && depth <= 0) {
          return i + 1;
        }
      }
    }
  }
  return startIdx + 1;
}

function computeIndentBlockEndLine(lines: string[], startIdx: number): number {
  const baseIndent = lines[startIdx]!.search(/\S/);
  let endIdx = startIdx;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.search(/\S/);
    if (indent <= baseIndent) {
      break;
    }
    endIdx = i;
  }
  return endIdx + 1;
}

function extractTreeSitterSymbols(
  posixPath: string,
  sourceCode: string,
  parser: Parser
): CodeSymbol[] {
  const tree = parser.parse(sourceCode);
  if (!tree) throw new Error("Tree-sitter não retornou uma árvore de sintaxe.");
  const symbols: CodeSymbol[] = [];

  const visit = (node: { type: string; startPosition: { row: number }; endPosition: { row: number }; childForFieldName(name: string): { text: string } | null; children: unknown[] }) => {
    const type = node.type;
    let kind: CodeSymbol["kind"] | undefined;
    if (type === "function_definition" || type === "function_declaration" || type === "function_item") {
      kind = "function";
    } else if (type === "method_declaration" || type === "method_definition") {
      kind = "method";
    } else if (type === "class_definition" || type === "class_declaration" || type === "struct_item" || type === "enum_item") {
      kind = "class";
    } else if (type === "interface_declaration" || type === "trait_item") {
      kind = "interface";
    }

    if (kind) {
      const nameNode = node.childForFieldName("name");
      if (nameNode?.text) {
        symbols.push({
          name: nameNode.text,
          kind,
          filePath: posixPath,
          line: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1
        });
      }
    }

    for (const child of node.children) {
      visit(child as typeof node);
    }
  };

  try {
    if (tree.rootNode.hasError) throw new Error("Tree-sitter encontrou erro de sintaxe.");
    visit(tree.rootNode as unknown as Parameters<typeof visit>[0]);
    return symbols;
  } finally {
    tree.delete();
  }
}

function extractPythonSymbols(posixPath: string, lines: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const lineText = lines[idx]!;
    const routeMatch = PYTHON_ROUTE_REGEX.exec(lineText);
    if (routeMatch?.[1]) {
      symbols.push({ name: routeMatch[1], kind: "route", filePath: posixPath, line: idx + 1, endLine: idx + 1 });
      continue;
    }
    const classMatch = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(lineText);
    if (classMatch?.[1]) {
      symbols.push({
        name: classMatch[1],
        kind: "class",
        filePath: posixPath,
        line: idx + 1,
        endLine: computeIndentBlockEndLine(lines, idx)
      });
      continue;
    }
    const defMatch = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(lineText);
    if (defMatch?.[2]) {
      const indent = defMatch[1]?.length ?? 0;
      symbols.push({
        name: defMatch[2],
        kind: indent > 0 ? "method" : "function",
        filePath: posixPath,
        line: idx + 1,
        endLine: computeIndentBlockEndLine(lines, idx)
      });
    }
  }
  return symbols;
}

function extractGoSymbols(posixPath: string, lines: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const lineText = lines[idx]!;
    const routeMatch = GO_ROUTE_REGEX.exec(lineText);
    if (routeMatch?.[1]) {
      symbols.push({ name: routeMatch[1], kind: "route", filePath: posixPath, line: idx + 1, endLine: idx + 1 });
    }
    const methodMatch = /^\s*func\s+\([^)]+\)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(lineText);
    if (methodMatch?.[1]) {
      symbols.push({
        name: methodMatch[1],
        kind: "method",
        filePath: posixPath,
        line: idx + 1,
        endLine: computeBraceBlockEndLine(lines, idx)
      });
      continue;
    }
    const funcMatch = /^\s*func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(lineText);
    if (funcMatch?.[1]) {
      symbols.push({
        name: funcMatch[1],
        kind: "function",
        filePath: posixPath,
        line: idx + 1,
        endLine: computeBraceBlockEndLine(lines, idx)
      });
      continue;
    }
    const ifaceMatch = /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+interface\b/.exec(lineText);
    if (ifaceMatch?.[1]) {
      symbols.push({
        name: ifaceMatch[1],
        kind: "interface",
        filePath: posixPath,
        line: idx + 1,
        endLine: computeBraceBlockEndLine(lines, idx)
      });
      continue;
    }
    const structMatch = /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\b/.exec(lineText);
    if (structMatch?.[1]) {
      symbols.push({
        name: structMatch[1],
        kind: "class",
        filePath: posixPath,
        line: idx + 1,
        endLine: computeBraceBlockEndLine(lines, idx)
      });
    }
  }
  return symbols;
}

function extractJavaSymbols(posixPath: string, lines: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  const JAVA_CONTROL_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "new", "synchronized"]);
  for (let idx = 0; idx < lines.length; idx++) {
    const lineText = lines[idx]!;
    const routeMatch = JAVA_ROUTE_REGEX.exec(lineText);
    if (routeMatch?.[1]) {
      symbols.push({ name: routeMatch[1], kind: "route", filePath: posixPath, line: idx + 1, endLine: idx + 1 });
      continue;
    }
    const ifaceMatch = /^\s*(?:public|protected|private|static|abstract|\s)*interface\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(lineText);
    if (ifaceMatch?.[1]) {
      symbols.push({
        name: ifaceMatch[1],
        kind: "interface",
        filePath: posixPath,
        line: idx + 1,
        endLine: computeBraceBlockEndLine(lines, idx)
      });
      continue;
    }
    const classMatch = /^\s*(?:public|protected|private|static|final|abstract|\s)*(?:class|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(lineText);
    if (classMatch?.[1]) {
      symbols.push({
        name: classMatch[1],
        kind: "class",
        filePath: posixPath,
        line: idx + 1,
        endLine: computeBraceBlockEndLine(lines, idx)
      });
      continue;
    }
    const methodMatch = /^\s*(?:public|protected|private|static|final|synchronized|abstract|default|\s)+[\w<>[\], ?]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;]*$/.exec(lineText);
    if (methodMatch?.[1] && !JAVA_CONTROL_KEYWORDS.has(methodMatch[1])) {
      symbols.push({
        name: methodMatch[1],
        kind: "method",
        filePath: posixPath,
        line: idx + 1,
        endLine: computeBraceBlockEndLine(lines, idx)
      });
    }
  }
  return symbols;
}

function extractRustSymbols(posixPath: string, lines: string[]): CodeSymbol[] {
  const symbols: CodeSymbol[] = [];
  let implDepth = 0;
  let inImpl = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const lineText = lines[idx]!;
    if (/^\s*impl(?:<[^>]+>)?\s+/.test(lineText)) {
      inImpl = true;
    }
    const routeMatch = RUST_ROUTE_REGEX.exec(lineText);
    if (routeMatch) {
      const route = routeMatch[1] ?? routeMatch[2];
      if (route) {
        symbols.push({ name: route, kind: "route", filePath: posixPath, line: idx + 1, endLine: idx + 1 });
      }
    }
    const traitMatch = /^\s*(?:pub(?:\([^)]+\))?\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(lineText);
    if (traitMatch?.[1]) {
      symbols.push({
        name: traitMatch[1],
        kind: "interface",
        filePath: posixPath,
        line: idx + 1,
        endLine: computeBraceBlockEndLine(lines, idx)
      });
    } else {
      const structMatch = /^\s*(?:pub(?:\([^)]+\))?\s+)?(?:struct|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(lineText);
      if (structMatch?.[1]) {
        symbols.push({
          name: structMatch[1],
          kind: "class",
          filePath: posixPath,
          line: idx + 1,
          endLine: computeBraceBlockEndLine(lines, idx)
        });
      } else {
        const fnMatch = /^\s*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/.exec(lineText);
        if (fnMatch?.[1]) {
          symbols.push({
            name: fnMatch[1],
            kind: inImpl && implDepth > 0 ? "method" : "function",
            filePath: posixPath,
            line: idx + 1,
            endLine: computeBraceBlockEndLine(lines, idx)
          });
        }
      }
    }

    if (inImpl) {
      for (const ch of lineText) {
        if (ch === "{") implDepth++;
        else if (ch === "}") {
          implDepth--;
          if (implDepth <= 0) {
            inImpl = false;
            implDepth = 0;
          }
        }
      }
    }
  }
  return symbols;
}

export function extractCodeSymbols(
  filePath: string,
  sourceCode: string,
  options?: ExtractCodeSymbolsOptions
): CodeSymbol[] {
  const posixPath = filePath.replace(/\\/g, "/");
  if (options?.treeSitterParser) {
    const symbols = extractTreeSitterSymbols(posixPath, sourceCode, options.treeSitterParser);
    const routes = extractCodeSymbols(posixPath, sourceCode).filter((symbol) => symbol.kind === "route");
    return [...symbols, ...routes];
  }
  if (/\.[cm]?[jt]sx?$/.test(posixPath)) {
    return extractTsAstSymbols(posixPath, sourceCode);
  }
  const lines = sourceCode.split(/\r?\n/);
  if (/\.py$/.test(posixPath)) {
    return extractPythonSymbols(posixPath, lines);
  }
  if (/\.go$/.test(posixPath)) {
    return extractGoSymbols(posixPath, lines);
  }
  if (/\.java$/.test(posixPath)) {
    return extractJavaSymbols(posixPath, lines);
  }
  if (/\.rs$/.test(posixPath)) {
    return extractRustSymbols(posixPath, lines);
  }

  const symbols: CodeSymbol[] = [];
  lines.forEach((lineText, idx) => {
    for (const pat of GENERIC_PATTERNS) {
      const m = pat.regex.exec(lineText);
      if (m?.[1]) {
        symbols.push({ name: m[1], kind: pat.kind, filePath: posixPath, line: idx + 1 });
      }
    }
  });

  return symbols;
}

/**
 * Extração determinística via AST do compilador TypeScript/JavaScript.
 */
export function extractTsAstSymbols(filePath: string, sourceCode: string): CodeSymbol[] {
  const posixPath = filePath.replace(/\\/g, "/");
  const sf = ts.createSourceFile(posixPath, sourceCode, ts.ScriptTarget.Latest, true);
  const symbols: CodeSymbol[] = [];

  const addSymbol = (name: string, kind: CodeSymbol["kind"], node: ts.Node) => {
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const { line: endLine } = sf.getLineAndCharacterOfPosition(node.getEnd());
    symbols.push({ name, kind, filePath: posixPath, line: line + 1, endLine: endLine + 1 });
  };

  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      addSymbol(node.name.text, "function", node);
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      addSymbol(node.name.text, "method", node);
    } else if (ts.isClassDeclaration(node) && node.name) {
      addSymbol(node.name.text, "class", node);
    } else if (ts.isInterfaceDeclaration(node)) {
      addSymbol(node.name.text, "interface", node);
    } else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const method = node.expression.name.text;
      if (["get", "post", "put", "patch", "delete"].includes(method) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        addSymbol(node.arguments[0].text, "route", node);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return symbols;
}

/**
 * Extrai dependências (imports/requires) determinísticas via AST / parsers dedicados.
 */
export function extractFileDependencies(filePath: string, sourceCode: string): string[] {
  const posixPath = filePath.replace(/\\/g, "/");
  const deps = new Set<string>();
  if (/\.[cm]?[jt]sx?$/.test(posixPath)) {
    const sf = ts.createSourceFile(posixPath, sourceCode, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        deps.add(node.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        deps.add(node.moduleSpecifier.text);
      } else if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        deps.add(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
    return [...deps];
  }

  if (/\.go$/.test(posixPath)) {
    const singleImport = /^\s*import\s+(?:[A-Za-z_][A-Za-z0-9_]*|\.|_)?\s*"([^"]+)"/gm;
    let m: RegExpExecArray | null;
    while ((m = singleImport.exec(sourceCode)) !== null) {
      if (m[1]) deps.add(m[1]);
    }
    const blockImport = /import\s*\(([\s\S]*?)\)/g;
    while ((m = blockImport.exec(sourceCode)) !== null) {
      const block = m[1] ?? "";
      const lineRegex = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*|\.|_)?\s*"([^"]+)"/gm;
      let lm: RegExpExecArray | null;
      while ((lm = lineRegex.exec(block)) !== null) {
        if (lm[1]) deps.add(lm[1]);
      }
    }
    return [...deps];
  }

  const pyFrom = /^\s*from\s+([A-Za-z0-9_.]+)\s+import\b/gm;
  let m: RegExpExecArray | null;
  while ((m = pyFrom.exec(sourceCode)) !== null) {
    if (m[1]) deps.add(m[1]);
  }
  const pyImport = /^\s*import\s+([^\n#]+)/gm;
  while ((m = pyImport.exec(sourceCode)) !== null) {
    const rawList = m[1] ?? "";
    for (const part of rawList.split(",")) {
      const mod = part.trim().split(/\s+as\s+/i)[0]?.trim();
      if (mod && /^[A-Za-z0-9_.]+$/.test(mod)) {
        deps.add(mod);
      }
    }
  }
  return [...deps];
}

let treeSitterInitialization: Promise<void> | undefined;

export async function initTreeSitterLanguage(wasmPath: string): Promise<Parser> {
  treeSitterInitialization ??= Parser.init();
  await treeSitterInitialization;
  const parser = new Parser();
  const lang = await Language.load(wasmPath);
  parser.setLanguage(lang);
  return parser;
}

export type TreeSitterGrammar = "javascript" | "typescript" | "tsx" | "python" | "go" | "java" | "rust";

export async function initBundledTreeSitterLanguage(grammar: TreeSitterGrammar): Promise<Parser> {
  const wasmPath = fileURLToPath(import.meta.resolve(`@repomix/tree-sitter-wasms/out/tree-sitter-${grammar}.wasm`));
  return initTreeSitterLanguage(wasmPath);
}

export interface ScipOccurrence {
  symbol: string;
  range: [number, number, number] | [number, number, number, number];
  role: "definition" | "reference";
}

export interface ScipDocument {
  relativePath: string;
  language: string;
  occurrences: ScipOccurrence[];
  symbols: ScipSymbolInformation[];
}

export interface ScipRelationship {
  symbol: string;
  isReference: boolean;
  isImplementation: boolean;
  isTypeDefinition: boolean;
  isDefinition: boolean;
}

export interface ScipSymbolInformation {
  symbol: string;
  displayName: string;
  kind: number;
  documentation: string[];
  enclosingSymbol: string;
  relationships: ScipRelationship[];
}

export interface ScipSymbolRecord extends ScipSymbolInformation {
  relativePath: string;
  language: string;
  definitionRange: ScipOccurrence["range"];
}

/** Returns one source-backed record per indexed definition; reference-only metadata is not a symbol node. */
export function extractScipSymbols(index: Pick<ScipIndex, "documents">): ScipSymbolRecord[] {
  const records = new Map<string, ScipSymbolRecord>();
  for (const document of index.documents) {
    const definitions = new Map(document.occurrences
      .filter((occurrence) => occurrence.role === "definition")
      .map((occurrence) => [occurrence.symbol, occurrence.range] as const));
    for (const symbol of document.symbols) {
      const definitionRange = definitions.get(symbol.symbol);
      if (!definitionRange || records.has(symbol.symbol)) continue;
      records.set(symbol.symbol, {
        ...symbol,
        documentation: [...symbol.documentation],
        relationships: symbol.relationships.map((relationship) => ({ ...relationship })),
        relativePath: document.relativePath,
        language: document.language,
        definitionRange: [...definitionRange] as ScipOccurrence["range"]
      });
    }
  }
  return [...records.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath) || a.symbol.localeCompare(b.symbol));
}

export interface ScipIndex {
  metadata: { toolInfo: string; projectRoot: string };
  documents: ScipDocument[];
}

export interface ScipDocumentRelationship {
  fromPath: string;
  toPath: string;
  relationType: "IMPLEMENTS" | "DEPENDS_ON";
  mappings: Array<{
    fromSymbol: string;
    toSymbol: string;
    kind: "IMPLEMENTS" | "REFERENCES" | "TYPE_DEFINITION" | "DEFINITION_ALIAS" | "ENCLOSED_BY";
    flags: Pick<ScipRelationship, "isReference" | "isImplementation" | "isTypeDefinition" | "isDefinition">;
  }>;
}

/** Maps SCIP symbol-level relationships onto the source documents that Brain ingests as KnowledgeItems. */
export function extractScipDocumentRelationships(index: Pick<ScipIndex, "documents">): ScipDocumentRelationship[] {
  const ownerBySymbol = new Map<string, string>();
  for (const document of index.documents) {
    for (const symbol of document.symbols) {
      if (!ownerBySymbol.has(symbol.symbol)) ownerBySymbol.set(symbol.symbol, document.relativePath);
    }
  }

  const grouped = new Map<string, ScipDocumentRelationship>();
  const add = (
    fromPath: string,
    toPath: string,
    fromSymbol: string,
    toSymbol: string,
    kind: ScipDocumentRelationship["mappings"][number]["kind"],
    flags: ScipDocumentRelationship["mappings"][number]["flags"]
  ) => {
    if (fromPath === toPath) return;
    const relationType = kind === "IMPLEMENTS" ? "IMPLEMENTS" : "DEPENDS_ON";
    const key = `${fromPath}\0${toPath}\0${relationType}`;
    const entry = grouped.get(key) ?? { fromPath, toPath, relationType, mappings: [] };
    const mapping = { fromSymbol, toSymbol, kind, flags };
    if (!entry.mappings.some((current) => current.fromSymbol === fromSymbol && current.toSymbol === toSymbol && current.kind === kind)) {
      entry.mappings.push(mapping);
    }
    grouped.set(key, entry);
  };

  for (const document of index.documents) {
    for (const symbol of document.symbols) {
      if (symbol.enclosingSymbol) {
        const targetPath = ownerBySymbol.get(symbol.enclosingSymbol);
        if (targetPath) add(document.relativePath, targetPath, symbol.symbol, symbol.enclosingSymbol, "ENCLOSED_BY", {
          isReference: false, isImplementation: false, isTypeDefinition: false, isDefinition: false
        });
      }
      for (const relationship of symbol.relationships) {
        const targetPath = ownerBySymbol.get(relationship.symbol);
        if (!targetPath) continue; // External/unindexed symbols do not become dangling graph nodes.
        const flags = {
          isReference: relationship.isReference,
          isImplementation: relationship.isImplementation,
          isTypeDefinition: relationship.isTypeDefinition,
          isDefinition: relationship.isDefinition
        };
        if (relationship.isImplementation) add(document.relativePath, targetPath, symbol.symbol, relationship.symbol, "IMPLEMENTS", flags);
        if (relationship.isReference) add(document.relativePath, targetPath, symbol.symbol, relationship.symbol, "REFERENCES", flags);
        if (relationship.isTypeDefinition) add(document.relativePath, targetPath, symbol.symbol, relationship.symbol, "TYPE_DEFINITION", flags);
        if (relationship.isDefinition) add(document.relativePath, targetPath, symbol.symbol, relationship.symbol, "DEFINITION_ALIAS", flags);
      }
    }
  }

  return [...grouped.values()]
    .map((entry) => ({ ...entry, mappings: entry.mappings.sort((a, b) => a.fromSymbol.localeCompare(b.fromSymbol) || a.toSymbol.localeCompare(b.toSymbol) || a.kind.localeCompare(b.kind)) }))
    .sort((a, b) => a.fromPath.localeCompare(b.fromPath) || a.toPath.localeCompare(b.toPath) || a.relationType.localeCompare(b.relationType));
}

function normalizeOccurrence(occurrence: ProtoScipOccurrence): ScipOccurrence {
  let range: number[];
  if (occurrence.typedRange.case === "singleLineRange") {
    range = [occurrence.typedRange.value.line, occurrence.typedRange.value.startCharacter, occurrence.typedRange.value.endCharacter];
  } else if (occurrence.typedRange.case === "multiLineRange") {
    range = [occurrence.typedRange.value.startLine, occurrence.typedRange.value.startCharacter, occurrence.typedRange.value.endLine, occurrence.typedRange.value.endCharacter];
  } else {
    range = occurrence.range;
  }
  if ((range.length !== 3 && range.length !== 4) || range.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error("Índice SCIP inválido: ocorrência sem range válido.");
  }
  if (!occurrence.symbol) throw new Error("Índice SCIP inválido: ocorrência sem símbolo.");
  return {
    symbol: occurrence.symbol,
    range: range as ScipOccurrence["range"],
    role: (occurrence.symbolRoles & SymbolRole.Definition) !== 0 ? "definition" : "reference"
  };
}

function normalizeSymbol(symbol: ProtoScipIndex["documents"][number]["symbols"][number]): ScipSymbolInformation {
  if (!symbol.symbol) throw new Error("Índice SCIP inválido: informação de símbolo sem identificador.");
  return {
    symbol: symbol.symbol,
    displayName: symbol.displayName,
    kind: symbol.kind,
    documentation: [...symbol.documentation],
    enclosingSymbol: symbol.enclosingSymbol,
    relationships: symbol.relationships.map((relationship) => {
      if (!relationship.symbol) throw new Error("Índice SCIP inválido: relação sem símbolo de destino.");
      return {
        symbol: relationship.symbol,
        isReference: relationship.isReference,
        isImplementation: relationship.isImplementation,
        isTypeDefinition: relationship.isTypeDefinition,
        isDefinition: relationship.isDefinition
      };
    })
  };
}

function normalizeProtoIndex(index: ProtoScipIndex): ScipIndex {
  const projectRoot = index.metadata?.projectRoot ?? "";
  const toolInfo = index.metadata?.toolInfo;
  return {
    metadata: {
      toolInfo: toolInfo?.name ? `${toolInfo.name}${toolInfo.version ? ` ${toolInfo.version}` : ""}` : "unknown SCIP indexer",
      projectRoot
    },
    documents: index.documents.map((document) => {
      const relativePath = document.relativePath.replace(/\\/g, "/");
      if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").some((part) => part === "." || part === "..")) {
        throw new Error(`Índice SCIP inválido: caminho relativo inseguro '${document.relativePath}'.`);
      }
      return {
        relativePath,
        language: document.language,
        occurrences: document.occurrences.map(normalizeOccurrence),
        symbols: document.symbols.map(normalizeSymbol)
      };
    })
  };
}

function validateNormalizedIndex(value: unknown): ScipIndex {
  if (!value || typeof value !== "object") throw new Error("Índice SCIP inválido.");
  const candidate = value as Partial<ScipIndex>;
  if (!candidate.metadata || typeof candidate.metadata.toolInfo !== "string" || typeof candidate.metadata.projectRoot !== "string" || !Array.isArray(candidate.documents)) {
    throw new Error("Índice SCIP inválido.");
  }
  const documents = candidate.documents.map((document) => {
    if (!document || typeof document.relativePath !== "string" || typeof document.language !== "string" || !Array.isArray(document.occurrences)) {
      throw new Error("Índice SCIP inválido: documento malformado.");
    }
    const relativePath = document.relativePath.replace(/\\/g, "/");
    if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").some((part) => part === "." || part === "..")) {
      throw new Error(`Índice SCIP inválido: caminho relativo inseguro '${relativePath}'.`);
    }
    const occurrences = document.occurrences.map((occurrence) => {
      if (!occurrence || typeof occurrence.symbol !== "string" || !Array.isArray(occurrence.range) ||
          (occurrence.role !== "definition" && occurrence.role !== "reference")) throw new Error("Índice SCIP inválido: ocorrência malformada.");
      const normalized = normalizeOccurrence({
        symbol: occurrence.symbol,
        range: occurrence.range,
        symbolRoles: occurrence.role === "definition" ? SymbolRole.Definition : 0,
        typedRange: { case: undefined },
        overrideDocumentation: [], enclosingRange: [], typedEnclosingRange: { case: undefined },
        syntaxKind: 0, diagnostics: []
      } as unknown as ProtoScipOccurrence);
      return normalized;
    });
    const rawSymbols = Array.isArray((document as { symbols?: unknown }).symbols)
      ? (document as { symbols: unknown[] }).symbols
      : [];
    const symbols = rawSymbols.map((value) => {
      if (!value || typeof value !== "object") throw new Error("Índice SCIP inválido: informação de símbolo malformada.");
      const symbol = value as Partial<ScipSymbolInformation>;
      if (typeof symbol.symbol !== "string" || !symbol.symbol || !Array.isArray(symbol.documentation) ||
          typeof symbol.displayName !== "string" || typeof symbol.kind !== "number" ||
          typeof symbol.enclosingSymbol !== "string" || !Array.isArray(symbol.relationships)) {
        throw new Error("Índice SCIP inválido: informação de símbolo malformada.");
      }
      const relationships = symbol.relationships.map((relationship) => {
        if (!relationship || typeof relationship.symbol !== "string" || !relationship.symbol ||
            typeof relationship.isReference !== "boolean" || typeof relationship.isImplementation !== "boolean" ||
            typeof relationship.isTypeDefinition !== "boolean" || typeof relationship.isDefinition !== "boolean") {
          throw new Error("Índice SCIP inválido: relação de símbolo malformada.");
        }
        return { ...relationship };
      });
      if (symbol.documentation.some((entry) => typeof entry !== "string")) throw new Error("Índice SCIP inválido: documentação de símbolo malformada.");
      return { ...symbol, documentation: [...symbol.documentation], relationships } as ScipSymbolInformation;
    });
    return { relativePath, language: document.language, occurrences, symbols };
  });
  return { metadata: candidate.metadata, documents };
}

export function parseScipIndex(input: Uint8Array | string): ScipIndex {
  if (typeof input !== "string" && input[0] === 0x7b) {
    return parseScipIndex(new TextDecoder().decode(input));
  }
  if (typeof input === "string") {
    try {
      return validateNormalizedIndex(JSON.parse(input) as unknown);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Índice SCIP inválido")) throw error;
      throw new Error("Índice SCIP inválido: JSON não pôde ser decodificado.", { cause: error });
    }
  }
  try {
    return normalizeProtoIndex(fromBinary(IndexSchema, input));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Índice SCIP inválido")) throw error;
    throw new Error("Índice SCIP inválido: protobuf não pôde ser decodificado.", { cause: error });
  }
}

export function buildScipIndexerCommand(
  projectDir: string,
  language: "typescript" | "python",
  outputFile = "index.scip"
): { command: string; args: string[] } {
  const absoluteOutput = resolve(projectDir, outputFile);
  return language === "typescript"
    ? { command: "scip-typescript", args: ["index", "--output", absoluteOutput] }
    : { command: "scip-python", args: ["index", ".", "--output", absoluteOutput] };
}

export async function runExternalScipIndexer(
  projectDir: string,
  language: "typescript" | "python",
  outputFile = "index.scip"
): Promise<{ command: string; outputFile: string }> {
  const { command, args } = buildScipIndexerCommand(projectDir, language, outputFile);
  const absoluteOutput = resolve(projectDir, outputFile);
  try {
    await execFileAsync(command, args, { cwd: projectDir });
  } catch (error) {
    throw new Error(`Não foi possível gerar índice SCIP com ${command}. Instale o indexador Sourcegraph correspondente e tente novamente.`, { cause: error });
  }
  if (!existsSync(absoluteOutput)) throw new Error(`${command} terminou sem gerar ${absoluteOutput}.`);
  return { command: `${command} ${args.join(" ")}`, outputFile: absoluteOutput };
}

