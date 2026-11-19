import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthContext } from "@brain/auth";
import type { McpConnectionProfileName } from "./connection-profile.js";
import type { BrainRuntime } from "./runtime.js";
import { registerSubagentMcpTools } from "./subagent-tools.js";
import { registerExtendedAccessRbacTools } from "./tools/extended/access-rbac.js";
import { registerExtendedIngestionTools } from "./tools/extended/ingestion-knowledge.js";
import { registerExtendedRunnerOpsTools } from "./tools/extended/runner-ops.js";
import { registerExtendedSkillsSpecsTools } from "./tools/extended/skills-specs.js";
import { registerPlatformOpsTools } from "./tools/extended/platform-ops.js";
import { registerCodeTopologyTools } from "./tools/extended/code-topology.js";
import { registerIntelligenceTools } from "./tools/extended/intelligence-tools.js";
import { registerDailyIntelligenceTools } from "./tools/extended/daily-tools.js";

export function registerExtendedMcpTools(
  server: McpServer,
  runtime: BrainRuntime,
  ctx: AuthContext,
  auditPolicyId: string,
  profile: McpConnectionProfileName
): void {
  registerExtendedIngestionTools(server, runtime, ctx, auditPolicyId, profile);
  registerExtendedRunnerOpsTools(server, runtime, ctx, auditPolicyId, profile);
  registerExtendedAccessRbacTools(server, runtime, ctx, profile);
  registerExtendedSkillsSpecsTools(server, runtime, ctx, profile);
  registerPlatformOpsTools(server, runtime, ctx, auditPolicyId, profile);
  registerCodeTopologyTools(server, runtime, ctx, auditPolicyId, profile);
  registerIntelligenceTools(server, runtime, ctx, auditPolicyId, profile);
  registerDailyIntelligenceTools(server, runtime, ctx, auditPolicyId, profile);
  registerSubagentMcpTools(server, runtime, ctx, auditPolicyId, profile);
}
