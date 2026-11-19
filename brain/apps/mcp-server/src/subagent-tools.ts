import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthContext } from "@brain/auth";
import type { McpConnectionProfileName } from "./connection-profile.js";
import type { BrainRuntime } from "./runtime.js";
import { registerSubagentLifecycleTools } from "./subagent-tools/lifecycle.js";
import { registerSubagentMessagingTools } from "./subagent-tools/messaging.js";
import { collectVerifiedByEdges } from "./subagent-tools/ollama.js";
import { registerRunnerAdminTools } from "./subagent-tools/runner-admin.js";

export { collectVerifiedByEdges };

export function registerSubagentMcpTools(
  server: McpServer,
  runtime: BrainRuntime,
  ctx: AuthContext,
  auditPolicyId: string,
  profile: McpConnectionProfileName
): void {
  registerSubagentMessagingTools(server, runtime, ctx, auditPolicyId, profile);
  registerSubagentLifecycleTools(server, runtime, ctx, auditPolicyId, profile);
  registerRunnerAdminTools(server, runtime, ctx, auditPolicyId, profile);
}
