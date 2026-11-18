import { generateAdapterConfig, installIdeAdapter } from "../index.js";
export const cursorAdapter = {
  ide: "cursor" as const,
  generate: (opts?: { mcpCommand?: string; mcpUrl?: string }) => generateAdapterConfig("cursor", opts),
  install: (root: string, opts?: { mcpCommand?: string; mcpUrl?: string }) => installIdeAdapter(root, "cursor", opts)
};

