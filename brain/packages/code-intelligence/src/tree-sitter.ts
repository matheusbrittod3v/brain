import { Parser, Language } from "web-tree-sitter";

let initialized = false;

/**
 * Initializes the WebAssembly Tree-sitter runtime for multi-language AST code intelligence.
 */
export async function ensureTreeSitterInitialized(): Promise<void> {
  if (!initialized) {
    await Parser.init();
    initialized = true;
  }
}

export async function createTreeSitterParser(wasmPath: string): Promise<Parser> {
  await ensureTreeSitterInitialized();
  const parser = new Parser();
  const lang = await Language.load(wasmPath);
  parser.setLanguage(lang);
  return parser;
}

