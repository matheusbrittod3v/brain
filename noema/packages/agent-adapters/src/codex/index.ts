import { generateAdapterConfig, installIdeAdapter } from "../index.js";
export const codexAdapter = {
  ide: "codex" as const,
  generate: (opts?: { mcpCommand?: string; mcpUrl?: string }) => generateAdapterConfig("codex", opts),
  install: (root: string, opts?: { mcpCommand?: string; mcpUrl?: string }) => installIdeAdapter(root, "codex", opts)
};

