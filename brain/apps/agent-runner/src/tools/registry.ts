import { buildAbilityForContext, subject, type AuthContext, type CaslAction } from "@brain/auth";
import { tool, type Tool } from "ai";
import type { ZodTypeAny } from "zod";
import { truncateToolOutput } from "../core/compactor.js";

export interface RegisteredToolDef<TInput extends ZodTypeAny = ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: TInput;
  /** Optional CASL check enforced before executing this tool. */
  caslAction?: CaslAction;
  caslSubject?: "Project" | "Knowledge" | "Proposal" | "Runner";
  /** Maximum characters returned to the LLM before truncating (default 12_000). */
  maxOutputChars?: number;
  execute: (input: ReturnType<TInput["parse"]>, ctx: { auth: AuthContext; projectId: string }) => Promise<unknown>;
}

/**
 * Zod-typed tool registry with CASL authorization hooks.
 * Converts registered tools directly into Vercel AI SDK `tool()` definitions.
 */
export class AgentToolRegistry {
  private readonly tools = new Map<string, RegisteredToolDef>();

  register<TInput extends ZodTypeAny>(def: RegisteredToolDef<TInput>): this {
    this.tools.set(def.name, def as RegisteredToolDef);
    return this;
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): RegisteredToolDef | undefined {
    return this.tools.get(name);
  }

  list(): RegisteredToolDef[] {
    return [...this.tools.values()];
  }

  authorize(def: RegisteredToolDef, auth: AuthContext, projectId: string): { allowed: boolean; reason?: string } {
    if (!def.caslAction) return { allowed: true };
    const ability = buildAbilityForContext(auth);
    const targetSubject = def.caslSubject ?? "Knowledge";
    const allowed = ability.can(
      def.caslAction,
      subject(targetSubject, { projectId, accessPolicyId: auth.allowedPolicies[0] ?? "internal-project" })
    );
    return allowed
      ? { allowed: true }
      : { allowed: false, reason: `CASL negou '${def.caslAction}' em '${targetSubject}' para '${def.name}'.` };
  }

  /**
   * Builds Vercel AI SDK compatible tool map bound to the caller's AuthContext and projectId.
   */
  toVercelAiTools(
    auth: AuthContext,
    projectId: string,
    hooks?: {
      beforeToolCall?: (name: string, input: unknown) => Promise<{ block?: boolean; reason?: string } | void>;
      afterToolCall?: (name: string, output: string) => Promise<string | void>;
    }
  ) {
    const out: Record<string, Tool<any, any>> = {};
    for (const def of this.tools.values()) {
      out[def.name] = tool({
        description: def.description,
        inputSchema: def.inputSchema,
        execute: async (rawInput: unknown) => {
          const authz = this.authorize(def, auth, projectId);
          if (!authz.allowed) {
            return `ERROR: ${authz.reason}`;
          }
          if (hooks?.beforeToolCall) {
            const verdict = await hooks.beforeToolCall(def.name, rawInput);
            if (verdict?.block) {
              return `BLOCKED: ${verdict.reason ?? "Tool execution blocked by policy."}`;
            }
          }
          const parsed = def.inputSchema.parse(rawInput);
          const result = await def.execute(parsed, { auth, projectId });
          let serialized = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          serialized = truncateToolOutput(serialized, def.maxOutputChars ?? 12_000);
          if (hooks?.afterToolCall) {
            const modified = await hooks.afterToolCall(def.name, serialized);
            if (typeof modified === "string") serialized = modified;
          }
          return serialized;
        }
      });
    }
    return out;
  }
}
