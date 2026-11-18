import { generateAdapterConfig, installIdeAdapter } from "../index.js";
export const claudeCodeAdapter = {
  ide: "claude-code" as const,
  generate: (opts?: { mcpCommand?: string; mcpUrl?: string }) => generateAdapterConfig("claude-code", opts),
  install: (root: string, opts?: { mcpCommand?: string; mcpUrl?: string }) => installIdeAdapter(root, "claude-code", opts)
};

