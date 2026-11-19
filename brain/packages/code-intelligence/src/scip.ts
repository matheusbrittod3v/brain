import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fromBinary } from "@bufbuild/protobuf";
import { IndexSchema, SymbolRole, type Index as ProtoScipIndex, type Occurrence as ProtoScipOccurrence } from "@scip-code/scip";

const execFileAsync = promisify(execFile);

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
        if (!targetPath) continue;
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

