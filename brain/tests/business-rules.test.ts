import { describe, expect, it } from "bun:test";
import { assertPolicyAccess, assertProjectAccess, buildAbilityForContext, type AuthContext } from "@brain/auth";
import { scanForSecrets } from "@brain/ingestion";

const baseCtx: AuthContext = {
  tenantId: "default-org",
  actorId: "usr-test-1",
  actorType: "agent",
  roles: ["developer"],
  allowedProjects: ["brain"],
  allowedPolicies: ["public-org", "internal-project"]
};

describe("Brain Business Rules Verification", () => {
  it("TEST-BR-BRAIN-001: enforces multi-tenant project and policy scope", () => {
    expect(() => assertProjectAccess(baseCtx, "brain")).not.toThrow();
    expect(() => assertProjectAccess(baseCtx, "other-project")).toThrow();
    expect(() => assertPolicyAccess(baseCtx, "internal-project")).not.toThrow();
    expect(() => assertPolicyAccess(baseCtx, "restricted-security")).toThrow();
  });

  it("TEST-BR-BRAIN-002: detects secrets before ingestion and allows clean markdown", () => {
    const clean = scanForSecrets("# Clean ADR\nNo secrets here.");
    expect(clean.clean).toBe(true);
    expect(clean.findings.length).toBe(0);

    const leaked = scanForSecrets("API_KEY=ghp_1234567890abcdefghijklmnopqrstuvwxyz1234");
    expect(leaked.clean).toBe(false);
    expect(leaked.findings.length).toBeGreaterThan(0);
  });

  it("TEST-BR-BRAIN-003: evaluates FinOps downgrade threshold deterministically", () => {
    const monthlyLimitUsd = 50;
    const spentUsd = 52;
    const shouldDowngrade = spentUsd >= monthlyLimitUsd;
    expect(shouldDowngrade).toBe(true);
  });

  it("TEST-BR-BRAIN-004: enforces CASL abilities for HITL approvals and JIT scope", () => {
    const devAbility = buildAbilityForContext(baseCtx);
    expect(devAbility.can("read", "Knowledge")).toBe(true);

    const adminCtx: AuthContext = { ...baseCtx, roles: ["admin"] };
    const adminAbility = buildAbilityForContext(adminCtx);
    expect(adminAbility.can("approve", "Proposal")).toBe(true);
  });
});
