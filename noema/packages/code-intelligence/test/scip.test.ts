import test from "node:test";
import assert from "node:assert/strict";
import { create, toBinary } from "@bufbuild/protobuf";
import { IndexSchema } from "@scip-code/scip";
import { buildScipIndexerCommand, extractScipDocumentRelationships, extractScipSymbols, parseScipIndex } from "../src/index.js";

test("parseScipIndex decodes official SCIP protobuf definitions and references", () => {
  const bytes = toBinary(IndexSchema, create(IndexSchema, {
    metadata: { projectRoot: "file:///tmp/demo", toolInfo: { name: "scip-typescript", version: "1.0.0", arguments: [] } },
    documents: [{
      relativePath: "src/billing.ts",
      language: "typescript",
      occurrences: [
        { symbol: "scip-typescript npm demo 1.0.0 `src/billing.ts`/charge().", range: [4, 9, 15], symbolRoles: 1 },
        { symbol: "scip-typescript npm demo 1.0.0 `src/billing.ts`/charge().", range: [8, 2, 8], symbolRoles: 8 }
      ],
      symbols: [{
        symbol: "scip-typescript npm demo 1.0.0 `src/billing.ts`/charge().",
        displayName: "charge",
        kind: 17,
        documentation: ["Charges an invoice."],
        relationships: [{
          symbol: "scip-typescript npm demo 1.0.0 `src/billing.ts`/Payment#",
          isImplementation: true,
          isReference: false,
          isTypeDefinition: false,
          isDefinition: false
        }]
      }]
    }]
  }));

  const index = parseScipIndex(bytes);
  assert.equal(index.metadata.toolInfo, "scip-typescript 1.0.0");
  assert.equal(index.metadata.projectRoot, "file:///tmp/demo");
  assert.deepEqual(index.documents[0]?.occurrences.map((occurrence) => occurrence.role), ["definition", "reference"]);
  assert.deepEqual(index.documents[0]?.occurrences[0]?.range, [4, 9, 15]);
  assert.equal(index.documents[0]?.symbols[0]?.displayName, "charge");
  assert.deepEqual(index.documents[0]?.symbols[0]?.documentation, ["Charges an invoice."]);
  assert.deepEqual(index.documents[0]?.symbols[0]?.relationships, [{
    symbol: "scip-typescript npm demo 1.0.0 `src/billing.ts`/Payment#",
    isReference: false,
    isImplementation: true,
    isTypeDefinition: false,
    isDefinition: false
  }]);
});

test("parseScipIndex rejects malformed protobuf and JSON", () => {
  assert.throws(() => parseScipIndex(Uint8Array.from([255])), /SCIP/i);
  assert.throws(() => parseScipIndex("{not json"), /SCIP/i);
});

test("extractScipDocumentRelationships maps SCIP symbols to owning source documents", () => {
  const relationships = extractScipDocumentRelationships({
    documents: [
      {
        relativePath: "src/dog.ts", language: "typescript", occurrences: [], symbols: [{
          symbol: "demo Dog#", displayName: "Dog", kind: 12, documentation: [], enclosingSymbol: "",
          relationships: [{ symbol: "demo Animal#", isReference: false, isImplementation: true, isTypeDefinition: false, isDefinition: false }]
        }]
      },
      {
        relativePath: "src/animal.ts", language: "typescript", occurrences: [], symbols: [{
          symbol: "demo Animal#", displayName: "Animal", kind: 12, documentation: [], enclosingSymbol: "",
          relationships: []
        }]
      }
    ]
  });
  assert.deepEqual(relationships, [{
    fromPath: "src/dog.ts",
    toPath: "src/animal.ts",
    relationType: "IMPLEMENTS",
    mappings: [{
      fromSymbol: "demo Dog#",
      toSymbol: "demo Animal#",
      kind: "IMPLEMENTS",
      flags: { isReference: false, isImplementation: true, isTypeDefinition: false, isDefinition: false }
    }]
  }]);
});

test("extractScipSymbols emits only defined symbols with definition locations", () => {
  const symbols = extractScipSymbols({ documents: [{
    relativePath: "src/animal.ts", language: "typescript",
    occurrences: [
      { symbol: "demo Animal#", range: [2, 0, 6], role: "definition" },
      { symbol: "demo Animal#", range: [8, 0, 6], role: "reference" }
    ],
    symbols: [{ symbol: "demo Animal#", displayName: "Animal", kind: 12, documentation: ["Base animal."], enclosingSymbol: "demo #", relationships: [] }]
  }] });
  assert.deepEqual(symbols, [{
    symbol: "demo Animal#", displayName: "Animal", kind: 12, documentation: ["Base animal."],
    enclosingSymbol: "demo #", relationships: [], relativePath: "src/animal.ts", language: "typescript",
    definitionRange: [2, 0, 6]
  }]);
});

test("buildScipIndexerCommand uses language-specific official CLI arguments and absolute output", () => {
  assert.deepEqual(buildScipIndexerCommand("/tmp/demo", "typescript", "index.scip"), {
    command: "scip-typescript",
    args: ["index", "--output", "/tmp/demo/index.scip"]
  });
  assert.deepEqual(buildScipIndexerCommand("/tmp/demo", "python", "index.scip"), {
    command: "scip-python",
    args: ["index", ".", "--output", "/tmp/demo/index.scip"]
  });
});
