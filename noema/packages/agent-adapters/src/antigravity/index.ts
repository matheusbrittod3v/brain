import { generateAdapterConfig, installIdeAdapter } from "../index.js";
export const antigravityAdapter = {
  ide: "antigravity" as const,
  generate: (opts?: { mcpCommand?: string; mcpUrl?: string }) => generateAdapterConfig("antigravity", opts),
  install: (root: string, opts?: { mcpCommand?: string; mcpUrl?: string }) => installIdeAdapter(root, "antigravity", opts)
};

