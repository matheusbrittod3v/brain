import { generateAdapterConfig, installIdeAdapter } from "../index.js";
export const kiroAdapter = {
  ide: "kiro" as const,
  generate: (opts?: { mcpCommand?: string; mcpUrl?: string }) => generateAdapterConfig("kiro", opts),
  install: (root: string, opts?: { mcpCommand?: string; mcpUrl?: string }) => installIdeAdapter(root, "kiro", opts)
};

